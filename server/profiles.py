"""Public member profiles and the selections a member chooses to display."""
import json
import re
import unicodedata

from flask import jsonify, request

from .discussion import valid_score

SCHEMA = """
CREATE TABLE IF NOT EXISTS member_showcases (
 user_id INTEGER PRIMARY KEY REFERENCES accounts(id), favorites TEXT, featured TEXT
);
"""


def mount(app, db, active_user, fail, imported, seed_ids):
    member_query = """
        SELECT a.id, a.username, m.name AS original,
               EXISTS(SELECT 1 FROM avatars v WHERE v.user_id=a.id) AS avatar
        FROM accounts a LEFT JOIN member_claims m ON m.owner=a.id
    """

    def identity(row):
        return dict(id=row["id"], username=row["username"], original=row["original"], hasAvatar=bool(row["avatar"]))

    def reserved(name):
        return dict(id=None, username=name, original=name, hasAvatar=False)

    @app.get("/api/members")
    def members():
        people = [identity(r) for r in db().execute(member_query + " ORDER BY a.id")]
        taken = {name for p in people for name in (p["original"], p["username"])}
        people.extend(reserved(n) for n in sorted(imported - taken))
        return jsonify(members=people)

    def published(key):
        return isinstance(key, str) and (key in seed_ids or db().execute(
            "SELECT 1 FROM contributions WHERE id=? AND live IS NOT NULL", (key,)).fetchone() is not None)

    def selections(account_id):
        row = db().execute("SELECT favorites,featured FROM member_showcases WHERE user_id=?", (account_id,)).fetchone()
        favs, comments = (json.loads(v) if v else [] for v in (row or (None, None)))
        featured = []
        for c in comments:
            if re.fullmatch(r"c-\d+-[a-f0-9-]{36}", c["id"]) and not db().execute(
                    "SELECT 1 FROM work_comments WHERE id=? AND user_id=? AND work_id=?",
                    (c["id"],account_id,c["workId"])).fetchone():
                continue
            if published(c["workId"]):
                vote = db().execute("SELECT score FROM work_votes WHERE work_id=? AND user_id=?",
                                    (c["workId"], account_id)).fetchone()
                if vote:
                    c["score"] = vote[0]
                featured.append(c)
        return dict(favoriteIds=[k for k in favs if published(k)], featuredComments=featured)

    @app.get("/api/members/id/<int:member_id>")
    @app.get("/api/members/name/<username>")
    def member(member_id=None, username=None):
        if member_id is not None:
            row = db().execute(member_query + " WHERE a.id=?", (member_id,)).fetchone()
        else:
            username = unicodedata.normalize("NFKC", username).strip()
            row = db().execute(member_query + " WHERE a.name_key=? OR m.name=?",
                               (username.casefold(), username)).fetchone()
        if row:
            person = identity(row)
        elif username in imported:
            person = reserved(username)
        else:
            return fail("找不到这位成员。", 404)
        works = [r["id"] for r in db().execute(
            "SELECT id FROM contributions WHERE author_id=? AND live IS NOT NULL ORDER BY updated DESC,id",
            (person["id"],))]
        return jsonify(**person, **selections(person["id"]), workIds=works)

    @app.post("/api/member-showcase")
    def save_showcase():
        data = request.json
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            user = active_user()
            if not user or data.get("accountId") != user["id"]:
                return fail("请使用自己的账号保存主页。", 403)
            init = data.get("initialize") is True
            values = {}
            for field, column in (("favoriteIds", "favorites"), ("featuredComments", "featured")):
                if field not in data:
                    continue
                items = data[field]
                if not isinstance(items, list) or len(items) > 3:
                    return fail("每个栏目最多展示三项。")
                result, seen = [], set()
                for item in items:
                    key = item if field == "favoriteIds" else item.get("workId") if isinstance(item, dict) else None
                    if not published(key):
                        if init:
                            continue
                        return fail("请选择已经发布的作品。")
                    if field == "favoriteIds":
                        item_key = key
                    else:
                        comment_id, text = item.get("id"), item.get("text")
                        if (not isinstance(comment_id, str) or not 1 <= len(comment_id) <= 250
                                or not isinstance(text, str) or not 1 <= len(text.strip()) <= 8000):
                            return fail("展示评论需要有效的编号和正文，正文最多 8000 字。")
                        score = item.get("score")
                        item = dict(id=comment_id, workId=key, text=text.strip())
                        if valid_score(score):
                            item["score"] = score
                        item_key = (key, comment_id)
                    if item_key in seen:
                        return fail("请移除重复的展示项目。")
                    seen.add(item_key)
                    result.append(item)
                values[column] = json.dumps(result, ensure_ascii=False)
            if not values:
                return fail("请选择要更新的栏目。")
            conn.execute("INSERT OR IGNORE INTO member_showcases(user_id) VALUES (?)", (user["id"],))
            for column, value in values.items():
                condition = f" AND {column} IS NULL" if init else ""
                conn.execute(f"UPDATE member_showcases SET {column}=? WHERE user_id=?" + condition, (value, user["id"]))
            return jsonify(**selections(user["id"]))
