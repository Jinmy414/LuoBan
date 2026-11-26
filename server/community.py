"""Shared work submissions, editorial review and profile images."""
import base64
import binascii
import io
import json
import re
import unicodedata
from urllib.parse import urlsplit

from flask import Response, jsonify, request, send_from_directory
from PIL import Image, ImageOps

from . import discussion, episodes, profiles, traffic

SCHEMA = """
CREATE TABLE IF NOT EXISTS playback_overrides (work_id TEXT PRIMARY KEY, url TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS watch_history (
 user_id INTEGER NOT NULL REFERENCES accounts(id), work_id TEXT NOT NULL, url TEXT NOT NULL,
 opened INTEGER NOT NULL, PRIMARY KEY(user_id,work_id)
);
CREATE TABLE IF NOT EXISTS avatars (
 user_id INTEGER PRIMARY KEY REFERENCES accounts(id), image BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS contributions (
 id TEXT PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES accounts(id),
 live TEXT, draft TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
 version INTEGER NOT NULL, updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS review_queue ON contributions(status, updated);
CREATE INDEX IF NOT EXISTS author_submissions ON contributions(author_id, updated);
""" + episodes.SCHEMA + discussion.SCHEMA
WORK_ID = re.compile(r"entry-[0-9a-f]{32}")
POSTERS = {"mint", "dusk", "sky", "lavender", "lemon", "ink"}


PLAYBACK_HOSTS = {
    "www.bilibili.com": "哔哩哔哩", "v.qq.com": "腾讯视频", "www.iqiyi.com": "爱奇艺",
    "v.youku.com": "优酷", "list.youku.com": "优酷", "www.youku.tv": "优酷",
    "www.netflix.com": "Netflix", "www.acfun.cn": "AcFun", "acg.gamer.com.tw": "動畫瘋",
    "abema.tv": "ABEMA", "www.disneyplus.com": "Disney+", "tv.cctv.com": "央视网",
}


def playback_platform(url):
    if not isinstance(url, str) or len(url) > 1800:
        return None
    try:
        parts = urlsplit(url)
        if parts.scheme == "https" and parts.netloc in PLAYBACK_HOSTS and parts.path.strip("/"):
            return PLAYBACK_HOSTS[parts.netloc]
    except ValueError:
        pass
    return None


def image_bytes(source, *, avatar=False):
    if not isinstance(source, str) or not re.match(r"^data:image/(jpeg|png|webp|gif);base64,", source):
        raise ValueError("请选择 JPG、PNG、WebP 或 GIF 图片。")
    try:
        raw = base64.b64decode(source.partition(",")[2], validate=True)
        with Image.open(io.BytesIO(raw), formats=["JPEG", "PNG", "WEBP", "GIF"]) as image:
            if image.width * image.height > 16_000_000:
                raise ValueError("图片尺寸太大，请缩小后重试。")
            rgb = ImageOps.exif_transpose(image).convert("RGB")
            if avatar:
                rgb = ImageOps.fit(rgb, (240, 240), method=Image.Resampling.LANCZOS)
            else:
                rgb.thumbnail((960, 1280))
            buffer = io.BytesIO()
            rgb.save(buffer, format="JPEG", quality=85)
            return buffer.getvalue()
    except (OSError, binascii.Error, Image.DecompressionBombError) as exc:
        raise ValueError("无法读取这张图片，请重新选择。") from exc


def title_key(title):
    text = unicodedata.normalize("NFKC", title).casefold()
    text = "".join(c for c in text if not c.isspace() and unicodedata.category(c) != "Cf")
    if text.startswith("《") and text.endswith("》"):
        text = text[1:-1]
    digits = "零一二三四五六七八九"

    def season(match):
        number = match[1]
        if number.isdecimal():
            value = int(number)
        elif "十" in number:
            tens, units = number.split("十")
            value = (digits.index(tens) if tens else 1) * 10 + (digits.index(units) if units else 0)
        else:
            value = digits.index(number)
        return f"第{value}季"

    return re.sub(r"第(\d+|[一二三四五六七八九]?十[一二三四五六七八九]?|[零一二三四五六七八九])季", season, text)


def work_fields(data, admin, previous, *, allow_unknown_year=False):
    def string(key, limit):
        value = data.get(key, "")
        if not isinstance(value, str) or len(value.strip()) > limit:
            raise ValueError("作品内容超过长度限制。")
        return value.strip()

    title, summary = string("title", 120), string("summary", 2400)
    region, year = data.get("region"), data.get("year")
    types, poster = data.get("types"), data.get("poster")
    if not title_key(title) or region not in ("中国", "日本", "欧美", "其他"):
        raise ValueError("请填写作品名称并选择地区。")
    if not (allow_unknown_year and year is None) and (type(year) is not int or not 1900 <= year <= 2100):
        raise ValueError("请填写 1900 到 2100 之间的年份。")
    if not isinstance(types, list) or not 1 <= len(types) <= 50 or any(
            not isinstance(t, str) or not re.fullmatch(r"[\w ·-]{1,24}", t) for t in types):
        raise ValueError("请选择有效的作品类型。")
    if not isinstance(poster, str) or poster not in POSTERS:
        raise ValueError("请选择封面颜色。")
    cover = string("coverImage", 2_800_000)
    if cover and cover != previous.get("coverImage"):
        if cover.startswith("data:image/") and admin:
            cover = "data:image/jpeg;base64," + base64.b64encode(image_bytes(cover)).decode()
        else:
            parsed = urlsplit(cover)
            if (len(cover) > 2048 or parsed.scheme not in ("http", "https") or not parsed.hostname
                    or re.search(r"""[\s'"()<>\\]""", cover)):
                raise ValueError("请填写完整的公开图片网址。")
    playback = string("playbackUrl", 1800)
    if playback and not playback_platform(playback):
        raise ValueError("请填写支持的播放平台 HTTPS 作品网址。")
    return dict(title=title, playbackUrl=playback, types=list(dict.fromkeys(types)), region=region, year=year,
                poster=poster, coverImage=cover, summary=summary)


def mount(app, db, active_user, public_user, now, fail, root, imported):
    catalogue = json.loads((root / "assets" / "playback.json").read_text())
    seed_works = []
    for filename in ("animation-works.js", "series-works.js"):
        content = (root / "assets" / filename).read_text()
        seed_works.extend(json.loads(content.partition(" = ")[2].strip().rstrip(";")))
    seed_ids = {work["id"] for work in seed_works}
    seed_titles = {title_key(work["title"]): work["id"] for work in seed_works}
    work_names = {work["id"]: work["title"] for work in seed_works}
    season_data = (root / "assets" / "anime-seasons.js").read_text()
    season_ids = set()
    for series in json.loads(season_data.partition(" = ")[2].strip().rstrip(";")):
        root_id = series["rootId"]
        title = work_names[root_id]
        if series.get("combined"):
            season_ids.add(root_id + "-s1")
        seed_titles.setdefault(title_key(title + "第一季"), root_id)
        for season in series["seasons"]:
            season_id = f"{root_id}-s{season['n']}"
            season_ids.add(season_id)
            seed_titles.setdefault(title_key(season["title"]), season_id)
            seed_titles.setdefault(title_key(title + season["label"]), season_id)
    season_links = {key: catalogue[key] for key in season_ids if key in catalogue}
    platform_by_link = {(key, link["url"]):link["platform"] for key, links in season_links.items() for link in links}

    def duplicate_title(conn, title, current_id):
        normalized = title_key(title)
        public_id = seed_titles.get(normalized)
        pending = False
        if not public_id:
            for item in conn.execute("""
                    SELECT id, json_extract(live,'$.title') AS published_title,
                        CASE WHEN status='pending' THEN json_extract(draft,'$.title') END AS pending_title
                    FROM contributions WHERE id!=? AND (live IS NOT NULL OR status='pending')""", (current_id,)):
                if item["published_title"] and title_key(item["published_title"]) == normalized:
                    public_id = item["id"]
                    break
                if item["pending_title"] and title_key(item["pending_title"]) == normalized:
                    pending = True
        if public_id:
            return jsonify(error="这部作品已经上线。", workId=public_id), 409
        if pending:
            return fail("这部作品正在审核中，无需重复提交。", 409)
        return None

    def admin(user):
        return bool(user and public_user(user)["role"] in {"admin", "superadmin"})

    traffic.mount(app, active_user, admin)
    public_activity = discussion.mount(app, db, active_user, admin, fail, now, seed_works)
    episodes.mount(app, db, active_user, admin, now, fail, seed_ids | season_ids, season_links)
    profiles.mount(app, db, active_user, fail, imported, seed_ids)

    def entry(row, public=False):
        fields = json.loads(row["live"] if public else row["draft"])
        if public and fields["coverImage"].startswith("data:"):
            fields["coverImage"] = f"/api/works/{row['id']}/cover?v={row['version']}"
        item = dict(fields, id=row["id"], createdBy=row["username"], authorId=row["author_id"], version=row["version"])
        if not public:
            item.update(status=row["status"], reason=row["reason"])
            item["requestOnly"] = "requestNote" in fields and row["live"] is None
        return item

    base = "SELECT c.*, a.username FROM contributions c JOIN accounts a ON a.id=c.author_id "

    @app.get("/api/avatars/<username>")
    def avatar(username):
        row = db().execute("SELECT image FROM avatars JOIN accounts ON accounts.id=avatars.user_id WHERE name_key=?",
                           (username.casefold(),)).fetchone()
        if row:
            return Response(row["image"], mimetype="image/jpeg")
        return send_from_directory(root / "assets", "logo-snail.png")

    @app.get("/api/works")
    def published():
        rows = db().execute(base + "WHERE live IS NOT NULL ORDER BY updated DESC, c.id")
        overrides = {r["work_id"]: r["url"] for r in db().execute("SELECT * FROM playback_overrides")}
        aliases = {r["name"]: r["username"] for r in db().execute("""
            SELECT name,username FROM member_claims JOIN accounts ON accounts.id=member_claims.owner WHERE name!=username
        """)}
        return jsonify(works=[entry(row, True) for row in rows], playback=overrides, memberNames=aliases, discussion=public_activity())

    @app.post("/api/playback")
    def update_seed_source():
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if not admin(active_user()):
                return fail("只有管理员可以修改作品播放源。", 403)
            key, url = request.json.get("id"), request.json.get("url")
            if not isinstance(key, str) or key not in seed_ids or not isinstance(url, str) or (url and not playback_platform(url)):
                return fail("请填写支持平台的作品网址。")
            conn.execute("INSERT OR REPLACE INTO playback_overrides VALUES (?,?)", (key,url))
        return jsonify(ok=True)

    @app.route("/api/history", methods=["GET","POST"])
    def watch_history():
        user = active_user()
        if not user:
            return fail("请先登录。", 401)
        if request.method == "POST":
            key, url = request.json.get("id"), request.json.get("url")
            if not isinstance(key, str) or not isinstance(url, str) or not (
                    playback_platform(url) or (key, url) in platform_by_link):
                return fail("请从作品的播放入口打开。")
            known = {link["url"] for link in catalogue.get(key, [])}
            override = db().execute("SELECT url FROM playback_overrides WHERE work_id=?", (key,)).fetchone()
            if override:
                known.add(override["url"])
            row = db().execute("SELECT live FROM contributions WHERE id=?", (key,)).fetchone()
            if row and row["live"]:
                known.add(json.loads(row["live"]).get("playbackUrl"))
            if url not in known:
                return fail("该播放源已更新，请刷新作品页面。", 409)
            with db() as conn:
                conn.execute("""INSERT INTO watch_history VALUES (?,?,?,?) ON CONFLICT(user_id,work_id)
                    DO UPDATE SET url=excluded.url,opened=excluded.opened""", (user["id"],key,url,now()))
            return jsonify(ok=True)
        rows = db().execute("""SELECT h.*,p.source,p.label,p.seconds FROM watch_history h
            LEFT JOIN episode_progress p ON h.user_id=p.user_id AND h.work_id=p.work_id
            WHERE h.user_id=? ORDER BY h.opened DESC,h.rowid DESC""", (user["id"],))
        items = []
        for r in rows:
            platform = platform_by_link.get((r["work_id"], r["url"])) or playback_platform(r["url"])
            item = dict(id=r["work_id"], url=r["url"], platform=platform, opened=r["opened"])
            if r["url"] == episodes.HISTORY_MARKER:
                embedded = r["source"] in episodes.EMBED_URLS
                item.update(platform=episodes.SOURCES[r["source"]][0] if embedded else "罗瓣", episode=r["label"],
                            seconds=None if embedded else (r["seconds"] or 0))
            items.append(item)
        return jsonify(items=items)


    @app.get("/api/works/<work_id>/cover")
    def published_cover(work_id):
        row = db().execute("SELECT live FROM contributions WHERE id=?", (work_id,)).fetchone()
        source = json.loads(row["live"])["coverImage"] if row and row["live"] else ""
        if not source.startswith("data:"):
            return fail("找不到作品封面。", 404)
        return Response(base64.b64decode(source.partition(",")[2]), mimetype="image/jpeg")

    @app.get("/api/submissions")
    @app.get("/api/reviews")
    def submissions():
        user = active_user()
        if not user:
            return fail("请先登录。", 401)
        if request.path.endswith("/reviews"):
            if not admin(user):
                return fail("只有管理员可以审核作品。", 403)
            rows = db().execute(base + "WHERE status='pending' ORDER BY updated, c.id")
        else:
            rows = db().execute(base + "WHERE author_id=? ORDER BY updated DESC, c.id", (user["id"],))
        return jsonify(items=[entry(row) for row in rows])

    @app.get("/api/submissions/<key>")
    def submission_detail(key):
        user = active_user()
        row = db().execute(base + "WHERE c.id=?", (key,)).fetchone()
        if not user or not row or (row["author_id"] != user["id"] and not admin(user)):
            return fail("找不到可编辑的稿件。", 404)
        return jsonify(item=entry(row))

    @app.post("/api/submissions")
    @app.post("/api/reviews")
    def change_submission():
        user = active_user()
        if not user:
            return fail("请先登录。", 401)
        reviewing = request.path.endswith("/reviews")
        if reviewing and not admin(user):
            return fail("只有管理员可以审核作品。", 403)
        data = request.json
        action = data.get("action") if reviewing else "submit"
        if action not in (("approve", "reject", "delete") if reviewing else ("submit",)):
            return fail("请选择审核操作。")
        key, version = data.get("id"), data.get("version", 0)
        if not isinstance(key, str) or not WORK_ID.fullmatch(key) or type(version) is not int:
            return fail("作品编号或版本有误。")
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            user = active_user()
            if not user or (reviewing and not admin(user)):
                return fail("当前账号没有操作权限。", 403)
            row = conn.execute("SELECT * FROM contributions WHERE id=?", (key,)).fetchone()
            if row and not admin(user) and row["author_id"] != user["id"]:
                return fail("不能修改这部作品。", 403)
            if (row and row["version"] != version) or (not row and version != 0):
                return fail("作品状态已更新，请返回列表重新打开。", 409)
            if reviewing and (not row or (action != "delete" and row["status"] != "pending")):
                return fail("这部作品已处理或不存在。", 409)
            if not reviewing and (not row or row["status"] != "pending") and not admin(user):
                pending = conn.execute("SELECT COUNT(*) FROM contributions WHERE author_id=? AND status='pending'",
                                       (user["id"],)).fetchone()[0]
                if pending >= 20:
                    return fail("你有 20 篇待审稿件，请等待审核或编辑现有稿件。", 429)
            if action == "delete":
                conn.execute("DELETE FROM watch_history WHERE work_id=?", (key,))
                conn.execute("DELETE FROM episode_progress WHERE work_id=?", (key,))
                conn.execute("DELETE FROM episode_lines WHERE work_id=?", (key,))
                conn.execute("DELETE FROM comment_notices WHERE comment_id IN (SELECT id FROM work_comments WHERE work_id=?)", (key,))
                conn.execute("DELETE FROM work_comments WHERE work_id=?", (key,))
                conn.execute("DELETE FROM work_votes WHERE work_id=?", (key,))
                conn.execute("DELETE FROM contributions WHERE id=?", (key,))
                return jsonify(ok=True)
            previous = json.loads(row["draft"]) if row else {}
            note = previous.get("requestNote")
            wish = not reviewing and data.get("action") == "request"
            if wish:
                if row and (row["live"] or note is None):
                    return fail("请在作品资料页修改这部作品。", 409)
                note = data.get("requestNote", "")
                if not isinstance(note, str) or len(note.strip()) > 500:
                    return fail("留言最多 500 字。")
                note = note.strip()
                data = {"poster": "mint", **previous, **{k: data.get(k) for k in ("title", "region", "types")}}
            if row and row["live"] and isinstance(data.get("coverImage"), str) and data.get("coverImage", "").startswith(f"/api/works/{key}/cover?"):
                data = {**data, "coverImage": json.loads(row["live"])["coverImage"]}
            try:
                fields = work_fields(data, admin(user), previous, allow_unknown_year=note is not None)
            except ValueError as exc:
                return fail(str(exc))
            if action != "reject":
                duplicate = duplicate_title(conn, fields["title"], key)
                if duplicate:
                    return duplicate
            reason = data.get("reason", "")
            if action == "reject" and (not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 300):
                return fail("请填写退回原因，最多 300 字。")
            content = json.dumps(fields, ensure_ascii=False)
            draft = content if note is None else json.dumps({**fields, "requestNote": note}, ensure_ascii=False)
            status = {"approve": "approved", "reject": "rejected"}.get(action, "pending")
            if row:
                conn.execute("""UPDATE contributions SET draft=?, live=CASE WHEN ?='approved' THEN ? ELSE live END,
                                status=?, reason=?, version=version+1, updated=? WHERE id=?""",
                             (draft, status, content, status, reason.strip() if action == "reject" else "", now(), key))
            else:
                conn.execute("""INSERT INTO contributions(id,author_id,draft,status,version,updated)
                                VALUES (?,?,?,'pending',1,?)""", (key, user["id"], draft, now()))
        return jsonify(id=key, status=status, version=version+1)
