"""Account-bound scores and published comments on catalogue works."""
import datetime
import re
import json

from flask import jsonify, request

SCHEMA = """
CREATE TABLE IF NOT EXISTS work_votes (
 work_id TEXT NOT NULL, user_id INTEGER NOT NULL, score REAL NOT NULL, PRIMARY KEY(work_id,user_id)
);
CREATE TABLE IF NOT EXISTS work_comments (
 id TEXT PRIMARY KEY, work_id TEXT NOT NULL, user_id INTEGER NOT NULL, body TEXT NOT NULL, posted INTEGER NOT NULL,
 parent_id TEXT
);
CREATE TABLE IF NOT EXISTS comment_notices (
 recipient INTEGER NOT NULL REFERENCES accounts(id), comment_id TEXT NOT NULL, kind TEXT NOT NULL,
 read_at INTEGER, PRIMARY KEY(recipient,comment_id)
);
CREATE INDEX IF NOT EXISTS pending_notices ON comment_notices(recipient,read_at);
CREATE INDEX IF NOT EXISTS work_comments_by_author ON work_comments(work_id,user_id);
"""


def valid_score(value):
    return type(value) in (int, float) and 0 <= value <= 10 and value * 2 == int(value * 2)


def mount(app, db, active_user, admin, fail, now, seed_works):
    seeds = {w["id"]: w for w in seed_works}
    seed_authors = {w["id"]: {c["user"] for c in w["comments"]} for w in seed_works}

    seed_comments = {w["id"]: {c["id"]:c for c in w["comments"]} for w in seed_works}

    def parent_comment(key, comment_id):
        if not isinstance(comment_id, str) or len(comment_id) > 250:
            return None
        row = db().execute("""SELECT c.user_id, a.username, c.body FROM work_comments c
            JOIN accounts a ON a.id=c.user_id WHERE c.work_id=? AND c.id=?""", (key,comment_id)).fetchone()
        if row:
            return dict(id=comment_id, authorId=row[0], user=row[1], text=row[2])
        seed = seed_comments.get(key, {}).get(comment_id)
        if seed:
            owner = db().execute("""SELECT a.id,a.username FROM member_claims m JOIN accounts a ON a.id=m.owner
                WHERE m.name=?""", (seed["user"],)).fetchone()
            return dict(id=comment_id, authorId=owner[0] if owner else None,
                        user=owner[1] if owner else seed["user"], text=seed["text"])
        return None

    @app.route("/api/comment-notices", methods=["GET","POST"])
    def notices():
        user = active_user()
        if not user:
            return fail("请先登录。", 401)
        if request.method == "POST":
            comment_id = request.json.get("commentId")
            if request.json.get("accountId") != user["id"] or not isinstance(comment_id,str):
                return fail("请重新打开这条提醒。", 403)
            with db() as conn:
                conn.execute("UPDATE comment_notices SET read_at=COALESCE(read_at,?) WHERE recipient=? AND comment_id=?",
                             (now(),user["id"],comment_id))
            return jsonify(ok=True)
        rows = db().execute("""SELECT n.kind,c.*,a.username,w.live FROM comment_notices n
            JOIN work_comments c ON c.id=n.comment_id JOIN accounts a ON a.id=c.user_id
            LEFT JOIN contributions w ON w.id=c.work_id WHERE n.recipient=? AND n.read_at IS NULL
            ORDER BY c.posted DESC,c.rowid DESC""", (user["id"],))
        items = []
        for r in rows:
            work = seeds.get(r["work_id"]) or (json.loads(r["live"]) if r["live"] else None)
            if work:
                items.append(dict(id=r["id"], kind=r["kind"], author=r["username"], authorId=r["user_id"],
                                  workId=r["work_id"], title=work["title"], text=r["body"], posted=r["posted"]))
        return jsonify(items=items)

    @app.post("/api/discussion/<key>")
    def edit_discussion(key):
        data = request.json
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            user = active_user()
            if not user or data.get("accountId") != user["id"]:
                return fail("请先登录再提交。", 401)
            if key not in seeds and not conn.execute(
                    "SELECT 1 FROM contributions WHERE id=? AND live IS NOT NULL", (key,)).fetchone():
                return fail("作品尚未发布。", 404)
            action = data.get("action")
            if action == "rate":
                score = data.get("score")
                if not valid_score(score):
                    return fail("评分须为 0 至 10 分之间的整数或半分。")
                conn.execute("INSERT INTO work_votes VALUES (?,?,?) ON CONFLICT(work_id,user_id) DO UPDATE SET score=excluded.score",
                             (key, user["id"], score))
            elif action == "comment":
                raw_id, body = data.get("id"), data.get("text")
                if not isinstance(raw_id, str) or not re.fullmatch(r"[a-f0-9-]{36}", raw_id):
                    return fail("评论编号有误。")
                if not isinstance(body, str) or not 1 <= len(body.strip()) <= 8000:
                    return fail("短评需要 1 至 8000 字。")
                comment_id = f"c-{user['id']}-{raw_id}"
                parent_id = data.get("replyTo")
                parent = parent_comment(key,parent_id) if parent_id else None
                if parent_id is not None and not parent:
                    return fail("原评论已移除，请取消回复后重试。", 409)
                added = conn.execute("INSERT OR IGNORE INTO work_comments VALUES (?,?,?,?,?,?)",
                                     (comment_id, key, user["id"], body.strip(), now(), parent_id))
                if not added.rowcount:
                    previous = conn.execute("SELECT work_id,body,parent_id FROM work_comments WHERE id=?", (comment_id,)).fetchone()
                    if tuple(previous) != (key, body.strip(), parent_id):
                        return fail("评论内容已变更，请重新提交。", 409)
                else:
                    owner = conn.execute("SELECT author_id FROM contributions WHERE id=? AND live IS NOT NULL",
                                         (key,)).fetchone()
                    recipients = {owner[0]: "work"} if owner else {}
                    if parent and parent["authorId"]:
                        recipients[parent["authorId"]] = "reply"
                    conn.executemany("INSERT INTO comment_notices VALUES (?,?,?,NULL)",
                                     [(recipient,comment_id,kind) for recipient,kind in recipients.items()
                                      if recipient != user["id"]])

                if valid_score(data.get("priorScore")):
                    conn.execute("INSERT OR IGNORE INTO work_votes VALUES (?,?,?)", (key, user["id"], data["priorScore"]))
            elif action == "remove" and admin(user):
                comment_id = data.get("id")
                if not isinstance(comment_id,str):
                    return fail("评论编号无效。")
                if conn.execute("DELETE FROM work_comments WHERE id=? AND work_id=?", (comment_id,key)).rowcount:
                    conn.execute("DELETE FROM comment_notices WHERE comment_id=?", (comment_id,))
            else:
                return fail("没有执行此操作的权限。", 403)
        return jsonify(ok=True)

    def public_activity():
        result = {}
        def entry(key):
            return result.setdefault(key, {"comments": [], "commentScores": {}})
        live = set(seeds)
        live.update(r[0] for r in db().execute("SELECT id FROM contributions WHERE live IS NOT NULL"))
        seen = set()
        aliases = {r["name"]: (r["id"],r["username"]) for r in db().execute(
            "SELECT m.name,a.id,a.username FROM member_claims m JOIN accounts a ON a.id=m.owner")}
        for r in db().execute("""SELECT c.*, a.username,p.body AS parent_text,p.user_id AS parent_author,
                                 pa.username AS parent_name FROM work_comments c JOIN accounts a ON a.id=c.user_id
                                 LEFT JOIN work_comments p ON p.id=c.parent_id AND p.work_id=c.work_id
                                 LEFT JOIN accounts pa ON pa.id=p.user_id ORDER BY c.posted,c.id"""):
            key = r["work_id"]
            if key not in live:
                continue
            parent = None
            if r["parent_text"] is not None:
                parent = dict(user=r["parent_name"], authorId=r["parent_author"], text=r["parent_text"][:180])
            elif r["parent_id"]:
                seed = seed_comments.get(key, {}).get(r["parent_id"])
                if seed:
                    owner, name = aliases.get(seed["user"], (None,seed["user"]))
                    parent = dict(user=name, authorId=owner, text=seed["text"][:180])
            seen.add((key,r["user_id"]))
            date = datetime.datetime.fromtimestamp(r["posted"],datetime.timezone.utc).date().isoformat()
            entry(key)["comments"].append(dict(id=r["id"], user=r["username"], authorId=r["user_id"],
                                               text=r["body"], date=date, sharedComment=True, replyTo=parent))
        votes = {}
        for r in db().execute("""SELECT v.*, a.username, m.name FROM work_votes v JOIN accounts a ON a.id=v.user_id
                                 LEFT JOIN member_claims m ON m.owner=v.user_id ORDER BY v.work_id,v.user_id"""):
            key = r["work_id"]
            if key not in live:
                continue
            original = r["name"] or r["username"]
            if (key,r["user_id"]) in seen or original in seed_authors.get(key, ()):
                entry(key)["commentScores"][r["username"]] = r["score"]
            if key not in votes:
                votes[key] = dict(seeds.get(key, {}).get("userRatings", {}))
            votes[key][original] = r["score"]
        for key, scores in votes.items():
            entry(key).update(votes=len(scores), ratingSum=sum(scores.values()))
        return result

    return public_activity
