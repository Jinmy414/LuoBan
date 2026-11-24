"""Per-work HLS catalogues. Only the viewer contacts the media host."""
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
CREATE TABLE IF NOT EXISTS installed_episode_lines (
 work_id TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(work_id,source)
);
"""

SOURCES = {
    "modu": ("魔都资源", "caiji.moduapi.cc"), "jinying": ("金鹰资源", "jinyingzy.com"),
    "hongniu": ("红牛资源", "www.hongniuzy2.com"), "liangzi": ("量子资源", "cj.lziapi.com"),
    "feifan": ("非凡资源", "ffzy5.tv"), "jisu": ("极速资源", "jszyapi.com"),
    "baofeng": ("暴风资源", "bfzyapi.com"), "baidu": ("百度资源", "api.apibdzy.com"),
    "custom": ("自定义片源", ""),
}
HISTORY_MARKER = "luoban:episodes"


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


def validated_catalogue(data):
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
        if not valid_hls_url(url):
            raise ValueError("分集需使用公开的 HTTPS .m3u8 地址。")
        labels.add(label.strip())
        result.append({"label": label.strip(), "url": url})
    return title.strip(), json.dumps(result, ensure_ascii=False, separators=(",", ":"))


def install_catalogues(conn, path):
    """Install each bundled line once. Later edits and removals belong to the administrator."""
    catalogues = json.loads(path.read_text(encoding="utf-8"))
    with conn:
        for line in catalogues:
            key = (line["work"], line["source"])
            installed = conn.execute("INSERT OR IGNORE INTO installed_episode_lines VALUES (?,?)", key)
            if not installed.rowcount:
                continue
            entries = [dict(label=f"第{i}集", url=url) for i, url in enumerate(line["urls"], 1)]
            title, body = validated_catalogue(dict(title=line["title"], episodes=entries))
            conn.execute("INSERT OR IGNORE INTO episode_lines VALUES (?,?,?,?,?)",
                         (*key, secrets.token_hex(8), title, body))


def mount(app, db, active_user, admin, now, fail, seed_ids):
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
            payload = dict(lines=lines, progress=dict(progress) if progress else None)
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
            else:
                try:
                    title, body = validated_catalogue(data)
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
            if not isinstance(source, str) or not isinstance(label, str) or type(seconds) is not int or not 0 <= seconds <= 604800:
                return fail("分集或观看进度有误。")
            line = conn.execute("SELECT revision,episodes FROM episode_lines WHERE work_id=? AND source=?", (key,source)).fetchone()
            if not line or line["revision"] != data.get("revision") or not any(e["label"] == label for e in json.loads(line["episodes"])):
                return fail("线路已更新，请重新打开作品。", 409)
            conn.execute("""INSERT INTO episode_progress VALUES (?,?,?,?,?) ON CONFLICT(user_id,work_id) DO UPDATE SET
                            source=excluded.source,label=excluded.label,seconds=excluded.seconds""",
                         (user["id"],key,source,label,seconds))
            conn.execute("""INSERT INTO watch_history VALUES (?,?,?,?) ON CONFLICT(user_id,work_id)
                            DO UPDATE SET url=excluded.url,opened=excluded.opened""", (user["id"],key,HISTORY_MARKER,now()))
        return jsonify(ok=True)
