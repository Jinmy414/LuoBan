"""Per-work playback catalogues. Only the viewer contacts the media host."""
import hashlib
import ipaddress
import json
import re
import secrets
from urllib.parse import urlsplit

from flask import jsonify, request

SCHEMA = """
CREATE TABLE IF NOT EXISTS episode_lines (
 work_id TEXT NOT NULL, source TEXT NOT NULL, revision TEXT NOT NULL,
 title TEXT NOT NULL, episodes TEXT NOT NULL, PRIMARY KEY(work_id,source)
);
CREATE TABLE IF NOT EXISTS episode_progress (
 user_id INTEGER NOT NULL, work_id TEXT NOT NULL, source TEXT NOT NULL, label TEXT NOT NULL,
 seconds INTEGER NOT NULL, PRIMARY KEY(user_id,work_id)
);
CREATE TABLE IF NOT EXISTS episode_opens (
 user_id INTEGER NOT NULL, work_id TEXT NOT NULL, source TEXT NOT NULL, label TEXT NOT NULL,
 PRIMARY KEY(user_id,work_id)
);
CREATE TABLE IF NOT EXISTS installed_episode_lines (
 work_id TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(work_id,source)
);
CREATE TABLE IF NOT EXISTS episode_bundle (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL);
"""

SOURCES = {
    "modu": ("魔都资源", "caiji.moduapi.cc"), "jinying": ("金鹰资源", "jinyingzy.com"),
    "hongniu": ("红牛资源", "www.hongniuzy2.com"), "liangzi": ("量子资源", "cj.lziapi.com"),
    "feifan": ("非凡资源", "ffzy5.tv"), "jisu": ("极速资源", "jszyapi.com"),
    "baofeng": ("暴风资源", "bfzyapi.com"), "baidu": ("百度资源", "api.apibdzy.com"),
    "ikun": ("iKun 资源", "ikunzyapi.com"), "ruyi": ("如意资源", "cj.rycjapi.com"),
    "360": ("360 资源", "360zy.com"),
    "bilibili": ("哔哩哔哩", ""), "youtube": ("YouTube", ""),
    "custom": ("自定义片源", ""),
}
EMBED_URLS = {
    "bilibili": re.compile(r"https://player\.bilibili\.com/player\.html\?(?:bvid=BV[0-9A-Za-z]{10}&p=[1-9]\d{0,3}|episodeId=[1-9]\d{0,11})"),
    "youtube": re.compile(r"https://www\.youtube\.com/embed/[0-9A-Za-z_-]{11}(?:\?start=(0|[1-9][0-9]{0,4})&end=([1-9][0-9]{0,4}))?"),
}
HISTORY_MARKER = "luoban:episodes"
OPEN_MARKER = "luoban:episode-opened"


def valid_hls_url(value):
    if not isinstance(value, str) or len(value) > 4096 or re.search(r'[\s\x00-\x1f\x7f\\]', value):
        return False
    try:
        parts = urlsplit(value)
        host = (parts.hostname or "").lower().rstrip(".")
        if (parts.scheme != "https" or "." not in host or parts.username is not None or parts.password is not None
                or parts.port not in (None, 443) or host.endswith((".local", ".localhost", ".internal"))
                or not parts.path.lower().endswith(".m3u8")):
            return False
        try:
            return ipaddress.ip_address(host).is_global
        except ValueError:
            return bool(re.fullmatch(r"[\w.-]+\.[a-z]{2,63}", host, re.ASCII))
    except ValueError:
        return False


def validated_catalogue(data, source="custom"):
    title, entries = data.get("title"), data.get("episodes")
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 200:
        raise ValueError("请核对剧集的片名。")
    if not isinstance(entries, list) or not 1 <= len(entries) <= 3000:
        raise ValueError("每条线路可导入 1 至 3000 集。")
    result, labels = [], set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("分集格式有误。")
        label, url = entry.get("label"), entry.get("url")
        if not isinstance(label, str) or not 1 <= len(label.strip()) <= 80 or label.strip() in labels:
            raise ValueError("请为每集提供不同的名称，最多 80 字。")
        if source in EMBED_URLS:
            match = EMBED_URLS[source].fullmatch(url) if isinstance(url, str) else None
            if not match or (source == "youtube" and match[1] and int(match[1]) >= int(match[2])):
                raise ValueError(f"请提供{SOURCES[source][0]}的分集嵌入地址。")
        elif not valid_hls_url(url):
            raise ValueError("分集需使用公开的 HTTPS .m3u8 地址。")
        labels.add(label.strip())
        result.append({"label": label.strip(), "url": url})
    return title.strip(), json.dumps(result, ensure_ascii=False, separators=(",", ":"))


def bundled_entries(line, urls_by_source):
    if "fromWork" in line:
        parent = (line["fromWork"], line["source"])
        urls = urls_by_source.get(parent)
        first, last = line.get("first"), line.get("last")
        if ("episodes" in line or "urls" in line or not isinstance(urls, list)
                or type(first) is not int or type(last) is not int or not 1 <= first <= last <= len(urls)):
            raise ValueError(f"Invalid bundled episode range for {line['work']} from {parent}: {first}..{last}")
        urls = urls[first - 1:last]
    elif "episodes" in line:
        return line["episodes"]
    else:
        urls = line["urls"]
    return [dict(label=f"第{i}集", url=url) for i, url in enumerate(urls, 1)]


def install_catalogues(conn, path):
    """Reconcile verified provider data while keeping administrator overrides and removals."""
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    def current_digest():
        return conn.execute("SELECT digest FROM episode_bundle WHERE id=1").fetchone()
    previous = current_digest()
    if previous and previous[0] == digest:
        return
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        previous = current_digest()
        if previous and previous[0] == digest:
            return
        installed = {(work, source) for work, source in conn.execute("SELECT work_id,source FROM installed_episode_lines")}
        existing = {(work, source): (revision, title, body) for work, source, revision, title, body in
                    conn.execute("SELECT work_id,source,revision,title,episodes FROM episode_lines")}
        lines = json.loads(raw)
        urls_by_source = {(line["work"], line["source"]): line["urls"] for line in lines if "urls" in line}
        keys = set()
        # Resolve the original lines before their ranges, regardless of file order.
        for line in sorted(lines, key=lambda item: "fromWork" in item):
            key = (line["work"], line["source"])
            if key in keys or key[1] not in SOURCES:
                raise ValueError(f"Invalid bundled source: {key}")
            keys.add(key)
            entries = bundled_entries(line, urls_by_source)
            title, body = validated_catalogue(dict(title=line["title"], episodes=entries), key[1])
            revision = "seed:" + hashlib.sha256((title + "\n" + body).encode()).hexdigest()[:24]
            old = existing.get(key)
            if key not in installed:
                conn.execute("INSERT INTO installed_episode_lines VALUES (?,?)", key)
                if "fromWork" in line:
                    # A removed or replaced original source must not reappear through a new season.
                    parent = conn.execute("SELECT revision FROM episode_lines WHERE work_id=? AND source=?",
                                          (line["fromWork"], line["source"])).fetchone()
                    if not parent or not parent[0].startswith("seed:"):
                        continue
                conn.execute("INSERT OR IGNORE INTO episode_lines VALUES (?,?,?,?,?)", (*key, revision, title, body))
            elif old and old[0] != revision:
                # Earlier releases used a random revision. Adopt only unchanged copies on upgrade.
                if old[0].startswith("seed:") or (not previous and old[1:] == (title, body)):
                    conn.execute("UPDATE episode_lines SET revision=?,title=?,episodes=? WHERE work_id=? AND source=?",
                                 (revision, title, body, *key))
        for key in installed - keys:
            old = existing.get(key)
            if old and old[0].startswith("seed:"):
                conn.execute("DELETE FROM episode_lines WHERE work_id=? AND source=?", key)
                conn.execute("DELETE FROM episode_progress WHERE work_id=? AND source=?", key)
                conn.execute("DELETE FROM episode_opens WHERE work_id=? AND source=?", key)
                conn.execute("DELETE FROM installed_episode_lines WHERE work_id=? AND source=?", key)
        conn.execute("INSERT OR REPLACE INTO episode_bundle VALUES (1,?)", (digest,))


def episode_summary(labels):
    episodes, issues, collections, other = {}, set(), 0, 0
    for label in labels:
        episode = re.fullmatch(r"第(\d+)集([上下]?)", label)
        issue = re.fullmatch(r"第(\d+)期(?:[上下])?", label)
        if episode:
            episodes.setdefault(int(episode[1]), set()).add(episode[2])
        elif issue:
            issues.add(int(issue[1]))
        elif "合集" in label or "合辑" in label:
            collections += 1
        else:
            other += 1
    counts = {"episodes": len(episodes), "issues": len(issues), "collections": collections, "other": other}
    summary = {key: value for key, value in counts.items() if value}
    if (episodes and set(episodes) == set(range(1, len(episodes) + 1))
            and all("" in parts or parts == {"上", "下"} for parts in episodes.values())):
        summary["sequential"] = True
    return summary


def mount(app, db, active_user, admin, now, fail, seed_ids, official_links, static_platform_ids):
    cached_lines = (None, {})

    @app.get("/api/playback-summary")
    def playback_summary():
        nonlocal cached_lines
        conn = db()
        revisions = tuple(tuple(r) for r in conn.execute(
            "SELECT work_id,source,revision FROM episode_lines ORDER BY work_id,source"))
        if revisions != cached_lines[0]:
            labels = {}
            providers = {}
            for key, source, entries in conn.execute("SELECT work_id,source,episodes FROM episode_lines"):
                labels.setdefault(key, set()).update(e["label"] for e in json.loads(entries))
                providers.setdefault(key, set()).add(source)
            summaries = {key: episode_summary(group) for key, group in labels.items()}
            for key, sources in providers.items():
                if sources == {"youtube"}:
                    summaries[key]["youtubeOnly"] = True
            cached_lines = (revisions, summaries)
        works = dict(cached_lines[1])
        platforms = set(static_platform_ids)
        platforms.update(key for key, in conn.execute("SELECT work_id FROM playback_overrides WHERE url!=''"))
        platforms.update(key for key, in conn.execute(
            "SELECT id FROM contributions WHERE json_extract(live,'$.playbackUrl')!=''"))
        return jsonify(works=works, platforms=sorted(platforms - works.keys()))

    def published(key):
        return key in seed_ids or db().execute(
            "SELECT 1 FROM contributions WHERE id=? AND live IS NOT NULL", (key,)).fetchone() is not None

    @app.route("/api/episodes/<key>", methods=["GET", "POST"])
    def catalogue(key):
        if request.method == "GET":
            if not published(key):
                return fail("这部作品尚未公开。", 404)
            user = active_user()
            rows = db().execute("SELECT * FROM episode_lines WHERE work_id=? ORDER BY rowid", (key,))
            lines = [dict(source=r["source"], name=SOURCES[r["source"]][0], title=r["title"], revision=r["revision"],
                          episodes=json.loads(r["episodes"])) for r in rows]
            progress = db().execute("SELECT source,label,seconds FROM episode_progress WHERE user_id=? AND work_id=?",
                                    (user["id"], key)).fetchone() if user else None
            opened = db().execute("""SELECT o.source,o.label FROM episode_opens o JOIN watch_history h
                USING (user_id,work_id) WHERE user_id=? AND work_id=? AND h.url=?""",
                                  (user["id"], key, OPEN_MARKER)).fetchone() if user else None
            payload = dict(lines=lines, progress=dict(progress) if progress else None, lastOpened=dict(opened) if opened else None,
                           officialLinks=official_links(key))
            if admin(user):
                payload["providers"] = [dict(id=k, name=v[0], host=v[1]) for k,v in SOURCES.items()]
            return jsonify(payload)
        data = request.json
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if not admin(active_user()):
                return fail("只有管理员可以导入分集。", 403)
            if not published(key):
                return fail("请先发布作品，再导入分集。", 404)
            source = data.get("source")
            if not isinstance(source, str) or source not in SOURCES:
                return fail("请选择片源。")
            row = conn.execute("SELECT revision FROM episode_lines WHERE work_id=? AND source=?", (key,source)).fetchone()
            if (row["revision"] if row else None) != data.get("revision"):
                return fail("这条线路已更新，请重新打开导入窗口再核对。", 409)
            if data.get("action") == "remove":
                conn.execute("DELETE FROM episode_lines WHERE work_id=? AND source=?", (key, source))
                conn.execute("DELETE FROM episode_progress WHERE work_id=? AND source=?", (key,source))
                conn.execute("DELETE FROM episode_opens WHERE work_id=? AND source=?", (key,source))
            else:
                try:
                    title, body = validated_catalogue(data, source)
                except ValueError as error:
                    return fail(str(error))
                conn.execute("""INSERT INTO episode_lines VALUES (?,?,?,?,?) ON CONFLICT(work_id,source)
                                DO UPDATE SET revision=excluded.revision,title=excluded.title,episodes=excluded.episodes""",
                             (key,source,secrets.token_hex(8),title,body))
        return jsonify(ok=True)

    @app.post("/api/episode-progress/<key>")
    def record_progress(key):
        data = request.json
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            user = active_user()
            if not user or data.get("accountId") != user["id"]:
                return fail("登录后可以同步观看进度。", 401)
            source, label, seconds = data.get("source"), data.get("label"), data.get("seconds")
            opened = data.get("kind") == "opened" or (seconds == 0 and isinstance(source, str) and source in EMBED_URLS)
            if (not isinstance(source, str) or not isinstance(label, str)
                    or (opened and (source not in EMBED_URLS or seconds not in (None, 0)))
                    or (not opened and (type(seconds) is not int or not 0 <= seconds <= 604800))):
                return fail("分集或观看进度有误。")
            line = conn.execute("SELECT revision,episodes FROM episode_lines WHERE work_id=? AND source=?", (key,source)).fetchone()
            if not line or line["revision"] != data.get("revision") or not any(e["label"] == label for e in json.loads(line["episodes"])):
                return fail("线路已更新，请重新打开作品。", 409)
            if not opened and seconds == 0:
                # Older native players posted zero as soon as the playing event fired.
                return jsonify(ok=True)
            marker = HISTORY_MARKER
            if opened:
                conn.execute("""INSERT INTO episode_opens VALUES (?,?,?,?) ON CONFLICT(user_id,work_id) DO UPDATE SET
                                source=excluded.source,label=excluded.label""", (user["id"],key,source,label))
                previous = conn.execute("""SELECT 1 FROM episode_progress
                    WHERE user_id=? AND work_id=? AND label=? AND seconds>0""", (user["id"],key,label)).fetchone()
                if not previous:
                    marker = OPEN_MARKER
            else:
                conn.execute("""INSERT INTO episode_progress VALUES (?,?,?,?,?) ON CONFLICT(user_id,work_id) DO UPDATE SET
                            source=excluded.source,label=excluded.label,seconds=excluded.seconds""",
                             (user["id"],key,source,label,seconds))
            conn.execute("""INSERT INTO watch_history VALUES (?,?,?,?) ON CONFLICT(user_id,work_id)
                            DO UPDATE SET url=excluded.url,opened=excluded.opened""", (user["id"],key,marker,now()))
        return jsonify(ok=True)
