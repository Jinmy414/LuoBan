import json
import base64
import io
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from contextlib import closing
from pathlib import Path

from PIL import Image
from server.app import create_app, digest, COOKIE


class CommunityTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = self.path = str(Path(directory.name) / "db")
        self.app = create_app({"TESTING": True, "DATABASE": path, "SUPER_ADMIN_ID": 1,
                               "SMTP_FROM":"test@example.test","SMTP_HOST":"smtp.example.test","AUTH_SECRET": "x"*48, "PUBLIC_ORIGIN": "https://example.test"})
        self.client = self.app.test_client()
        self.guest = self.app.test_client()
        self.data = dict(id="entry-"+"a"*32, version=0, title="初稿", region="中国", year=2026,
                         types=["原创"], poster="mint", coverImage="", summary="介绍")
        with closing(sqlite3.connect(path)) as conn, conn:
            for i in range(1, 4):
                conn.execute("INSERT INTO accounts VALUES (?,?,?,?,?)", (i, f"user{i}", f"user{i}", f"{i}@example.test", "unused"))
                conn.execute("INSERT INTO sessions VALUES (?,?,?)", (digest(str(i)), i, 9999999999))

    def post(self, path, **data):
        return self.client.post("/api/"+path, json=data, headers={"Origin":"https://example.test"})

    def as_user(self, user):
        self.client.set_cookie(COOKIE, str(user))

    def test_posting_limits_preserve_retries_and_existing_drafts(self):
        self.as_user(2)
        key = "animation-6-E7818CE7AFAEE9AB98E6898B"
        path = "discussion/" + key
        with closing(sqlite3.connect(self.path)) as conn, conn:
            for number in range(19):
                conn.execute("INSERT INTO work_comments VALUES (?,?,2,'short review',strftime('%s','now'),NULL)",
                             (str(number), key))
        comment = dict(accountId=2, action="comment", id="a"*36, text="短评")
        self.assertEqual(self.post(path, **comment).status_code, 200)
        self.assertEqual(self.post(path, **comment).status_code, 200)
        self.assertEqual(self.post(path, **{**comment, "id":"b"*36}).status_code, 429)
        self.as_user(3)
        self.assertEqual(self.post(path, **{**comment, "accountId":3}).status_code, 200)

        self.as_user(2)
        for number in range(20):
            self.assertEqual(self.post("submissions", **{**self.data, "id":f"entry-{number:032x}"}).status_code, 200)
        self.assertEqual(self.post("submissions", **self.data).status_code, 429)
        self.assertEqual(self.post("submissions", **{**self.data, "id":"entry-" + "0"*32, "version":1}).status_code, 200)

    def test_comment_scores_replies_and_persistent_notices(self):
        self.as_user(2)
        self.post("submissions", **self.data)
        self.as_user(1)
        self.post("reviews", **{**self.data, "version":1}, action="approve")
        key = self.data["id"]
        path = "discussion/" + key
        def comment(actor, n, text, parent=None):
            self.as_user(actor)
            client_id = f"00000000-0000-0000-0000-{n:012d}"
            self.assertEqual(self.post(path, action="comment", accountId=actor, id=client_id,
                                       text=text, replyTo=parent).status_code, 200)
            return f"c-{actor}-{client_id}"
        first = comment(2, 1, "作者的评论")
        def inbox(actor):
            self.as_user(actor)
            return self.client.get("/api/comment-notices").json["items"]
        self.assertEqual(inbox(2), [])
        reply = comment(3, 2, "同意", first)
        comment(3, 2, "同意", first)
        second = comment(3, 3, "补充")
        self.assertEqual(self.guest.get("/api/comment-notices").status_code, 401)
        self.assertEqual(inbox(3), [])
        self.assertEqual(self.post(path, action="rate", accountId=3, score=0).status_code, 200)
        activities = lambda: self.guest.get("/api/works").json["discussion"][key]
        self.assertEqual(activities()["commentScores"], {"user3":0})
        self.assertEqual(self.post(path, action="rate", accountId=3, score=8.5).status_code, 200)
        self.assertEqual(self.post(path, action="rate", accountId=3, score=8.8).status_code, 400)
        self.assertEqual(activities()["ratingSum"], 8.5)
        self.assertEqual(next(c for c in activities()["comments"] if c["id"] == reply)["replyTo"]["authorId"], 2)
        self.assertEqual([(i["id"],i["kind"]) for i in inbox(2)], [(second,"work"),(reply,"reply")])
        self.as_user(3)
        self.post("comment-notices", accountId=3, commentId=second)
        self.assertEqual(len(inbox(2)), 2)
        self.post("comment-notices", accountId=2, commentId=second)
        self.assertEqual([i["id"] for i in inbox(2)], [reply])
        comment(1, 4, "回访", second)
        self.assertEqual(inbox(3)[0]["kind"], "reply")
        self.assertEqual(inbox(2)[0]["kind"], "work")
        self.assertEqual(self.post(path, action="remove", accountId=2, id=reply).status_code, 403)
        self.as_user(1)
        self.post(path, action="remove", accountId=1, id=reply)
        self.assertNotIn(reply, [i["id"] for i in inbox(2)])
        self.assertNotIn(reply, [c["id"] for c in activities()["comments"]])

    def test_public_member_profiles_and_owner_selections(self):
        key = "animation-6-E7818CE7AFAEE9AB98E6898B"
        self.as_user(2)
        self.post("submissions", **self.data)
        comment = dict(id="c-1234", text="最喜欢这一幕", workId=key)
        self.assertEqual(self.post("member-showcase", accountId=2, favoriteIds=[self.data["id"]]).status_code, 400)
        self.assertEqual(self.post("member-showcase", accountId=2, favoriteIds=[key]).status_code, 200)
        self.assertEqual(self.post("member-showcase", accountId=2, initialize=True, favoriteIds=[],
                                   featuredComments=[comment]).json["favoriteIds"], [key])
        profile = self.guest.get("/api/members/id/2").json
        self.assertEqual(profile, dict(id=2, username="user2", original=None, hasAvatar=False, workIds=[],
                                      favoriteIds=[key], featuredComments=[comment]))
        self.assertEqual(self.guest.get("/api/members/name/USER2").json, profile)
        self.assertEqual(self.guest.get("/api/members/name/不存在").status_code, 404)
        self.assertEqual(self.guest.get("/api/members/name/罗").json["username"], "罗")
        self.assertEqual(self.guest.post("/api/member-showcase", json=dict(accountId=2,favoriteIds=[]),
                                        headers={"Origin":"https://example.test"}).status_code, 403)
        self.as_user(1)
        self.assertEqual(self.post("member-showcase", accountId=2, favoriteIds=[]).status_code, 403)
        self.assertEqual(self.post("reviews", **{**self.data, "version":1}, action="approve").status_code, 200)
        self.assertEqual(self.guest.get("/api/members/id/2").json["workIds"], [self.data["id"]])
        with closing(sqlite3.connect(self.path)) as conn, conn:
            conn.execute("INSERT INTO member_claims VALUES ('罗',NULL,0,2)")
            conn.execute("UPDATE accounts SET username='新名字',name_key='新名字' WHERE id=2")
        self.assertEqual(self.guest.get("/api/members/name/罗").json["favoriteIds"], [key])
        members = self.guest.get("/api/members").json["members"]
        self.assertFalse(any(m["username"] == "罗" for m in members))
        self.assertEqual(next(m for m in members if m["original"] == "罗")["username"], "新名字")
        self.as_user(2)
        self.assertEqual(self.post("member-showcase", accountId=2, favoriteIds=[]).json["featuredComments"], [comment])
        self.assertEqual(self.post("member-showcase", accountId=2, initialize=True, favoriteIds=[key]).json["favoriteIds"], [])

    def test_private_drafts_roles_review_edits_and_rejection(self):
        self.as_user(2)
        self.assertEqual(self.post("submissions", **self.data, status="approved").json["status"], "pending")
        self.assertEqual(self.guest.get("/api/works").json["works"], [])
        self.assertEqual(self.guest.get("/api/submissions").status_code, 401)
        self.as_user(3)
        self.assertFalse(self.client.get("/api/submissions").json["items"])
        self.assertEqual(self.post("submissions", **{**self.data,"version":1}).status_code, 403)
        self.assertEqual(self.post("reviews", **self.data, action="approve").status_code, 403)
        self.as_user(1)
        self.assertEqual(self.post("editors", id=3, grant=True).status_code, 200)
        self.assertEqual(self.post("editors", id=1, grant=False).status_code, 400)
        self.as_user(3)
        self.assertEqual(self.post("editors", id=2, grant=True).status_code, 403)
        self.assertEqual(len(self.client.get("/api/reviews").json["items"]), 1)
        self.assertEqual(self.post("reviews", **{**self.data,"version":1}, action="reject", reason="请补充").json["status"], "rejected")
        self.as_user(2)
        self.assertEqual(self.client.get("/api/submissions").json["items"][0]["reason"], "请补充")
        self.assertEqual(self.post("submissions", **{**self.data,"version":2}).json["status"], "pending")
        self.as_user(3)
        self.assertEqual(self.post("reviews", **{**self.data,"title":"终稿","version":3}, action="approve").status_code, 200)
        self.assertEqual(self.post("reviews", **{**self.data,"version":3}, action="approve").status_code, 409)
        self.assertEqual(self.guest.get("/api/works").json["works"][0]["title"], "终稿")
        self.as_user(2)
        self.post("submissions", **{**self.data,"version":4,"title":"下一版"})
        self.assertEqual(self.guest.get("/api/works").json["works"][0]["title"], "终稿")
        self.as_user(1)
        self.post("editors", id=3, grant=False)
        self.as_user(3)
        self.assertEqual(self.client.get("/api/reviews").status_code, 403)

    def test_avatar_persists_without_credential_change(self):
        self.as_user(2)
        raw = io.BytesIO()
        Image.new("RGB",(40,20),"red").save(raw,"PNG")
        avatar = "data:image/png;base64," + base64.b64encode(raw.getvalue()).decode()
        self.assertEqual(self.post("account", username="user2", avatar="invalid").status_code, 400)
        self.assertEqual(self.post("account", username="user2", avatar=avatar).status_code, 200)
        image = self.guest.get("/api/avatars/user2")
        self.assertEqual(image.mimetype, "image/jpeg")
        self.assertEqual(Image.open(io.BytesIO(image.data)).size, (240,240))
        self.assertEqual(self.post("account", username="renamed", avatar=avatar).status_code, 403)

    def test_reserved_member_first_login(self):
        self.as_user(2)
        self.assertEqual(self.post("member-invites",username="罗").status_code,403)
        self.as_user(1)
        first = self.post("member-invites",username="罗").json["code"]
        second = self.post("member-invites",username="罗").json["code"]
        self.assertEqual(self.post("email-code",email="reader@example.test",username="罗",claimCode=first).status_code,400)
        self.client.delete_cookie(COOKIE)
        with patch("server.app.send_code") as deliver:
            challenge = self.post("email-code",email="reader@example.test",username="罗",claimCode=second).json["challenge"]
            otp = deliver.call_args.args[2]
        ticket = self.post("verify-email",challenge=challenge,code=otp).json["ticket"]
        fields = dict(ticket=ticket,username="罗",password="unique-reader-pass")
        self.assertEqual(self.post("register",**fields).status_code,400)
        self.assertEqual(self.post("register",**fields,claimCode=second).json["user"]["username"],"罗")
        self.post("logout")
        self.assertEqual(self.post("login",identity="reader@example.test",password=fields["password"]).status_code,200)
        self.as_user(1)
        self.assertEqual(self.post("member-invites",username="罗").status_code,409)
        rows = self.client.get("/api/member-invites").json["members"]
        self.assertEqual(next(m for m in rows if m["username"]=="罗")["status"],"claimed")

    def test_playback_history_is_private_and_deduplicated(self):
        from server.app import ROOT
        import json
        sources = json.loads((ROOT / "assets/playback.json").read_text())
        key = next(iter(sources))
        link = sources[key][0]["url"]
        self.as_user(2)
        for _ in range(2):
            self.assertEqual(self.post("history",id=key,url=link).status_code,200)
        rows = self.client.get("/api/history").json["items"]
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]["url"],link)
        self.assertEqual(self.post("history",id=key,url="https://www.iqiyi.com/unknown").status_code,409)
        self.as_user(3)
        self.assertEqual(self.client.get("/api/history").json["items"],[])
        self.assertEqual(self.guest.get("/api/history").status_code,401)

    def test_bundled_episodes_survive_restart_and_respect_admin_changes(self):
        key = "animation-6-E7818CE7AFAEE9AB98E6898B"
        path = "episodes/" + key
        line = self.guest.get("/api/" + path).json["lines"][0]
        self.assertEqual([e["label"] for e in line["episodes"]], [f"第{i}集" for i in range(1, 102)])
        self.as_user(1)
        update = dict(source=line["source"], revision=line["revision"], title="管理员更新的线路",
                      episodes=line["episodes"][:1])
        self.assertEqual(self.post(path, **update).status_code, 200)
        restarted = create_app(self.app.config).test_client()
        changed = next(row for row in restarted.get("/api/" + path).json["lines"] if row["source"] == line["source"])
        self.assertEqual(changed["episodes"], update["episodes"])
        self.assertEqual(self.post(path, source=line["source"], revision=changed["revision"], action="remove").status_code, 200)
        restarted = create_app(self.app.config).test_client()
        self.assertNotIn(line["source"], [r["source"] for r in restarted.get("/api/" + path).json["lines"]])

    def test_variety_issue_labels_and_series_seasons(self):
        path = "/api/episodes/variety-houhui-youqi"
        lines = self.guest.get(path).get_json()["lines"]
        self.assertTrue(lines)
        for line in lines:
            labels = [entry["label"] for entry in line["episodes"]]
            self.assertEqual(labels[:4], ["第1期", "第2期", "第3期上", "第3期下"])
        for series, count in (("yellowstone-s5", 14), ("clarksons-farm-s5", 8)):
            lines = self.guest.get("/api/episodes/" + series).get_json()["lines"]
            self.assertTrue(lines)
            self.assertEqual([e["label"] for e in lines[0]["episodes"]], [f"第{i}集" for i in range(1, count + 1)])

    def test_platform_embeds_are_bound_to_provider_and_episode(self):
        from server.episodes import validated_catalogue
        url = "https://www.youtube.com/embed/MAIpv5WnqoY"
        data = dict(title="开心宝贝", episodes=[dict(label="第2集", url=url + "?start=699&end=1338")])
        self.assertIn("start=699", validated_catalogue(data, "youtube")[1])
        with self.assertRaises(ValueError):
            validated_catalogue(data, "bilibili")
        for invalid in (url + "?start=699&end=7", url + "?list=other", url.replace("www.youtube.com", "example.org")):
            data["episodes"][0]["url"] = invalid
            with self.assertRaises(ValueError):
                validated_catalogue(data, "youtube")

    def test_catalogue_refresh_updates_only_bundled_lines(self):
        from server.episodes import install_catalogues, SCHEMA
        with tempfile.TemporaryDirectory() as directory, closing(sqlite3.connect(":memory:")) as conn:
            data = Path(directory) / "verified.json"
            conn.executescript(SCHEMA)
            def save(sources, suffix):
                data.write_text(json.dumps([dict(work="work", source=source, title=source,
                    urls=[f"https://example.org/{suffix}.m3u8"]) for source in sources]))
                install_catalogues(conn, data)
            save(["modu", "jinying", "hongniu"], "before")
            with conn:
                conn.execute("UPDATE episode_lines SET revision='admin', title='自定义' WHERE source='hongniu'")
            save(["modu", "hongniu"], "after")
            found = {r[0]: r[1:] for r in conn.execute("SELECT source,title,episodes FROM episode_lines")}
            self.assertEqual(set(found), {"modu", "hongniu"})
            self.assertIn("after.m3u8", found["modu"][1])
            self.assertEqual(found["hongniu"][0], "自定义")
            self.assertIn("before.m3u8", found["hongniu"][1])

    def test_episode_import_permissions_and_private_resume(self):
        key = next(iter(json.loads((Path(__file__).resolve().parents[1] / "assets/playback.json").read_text())))
        path = "episodes/" + key
        data = dict(source="custom", title="分集样例", episodes=[dict(label="第1集",url="https://media.example.test/one.m3u8")])
        self.as_user(2)
        self.assertEqual(self.post(path, **data).status_code, 403)
        self.as_user(1)
        self.assertEqual(self.post("episodes/unknown", **data).status_code, 404)
        self.assertEqual(self.post(path, **{**data, "episodes":[dict(label="第1集",url="http://localhost/one.m3u8")]}).status_code, 400)
        self.assertEqual(self.post(path, **data).status_code, 200)
        guest = self.guest.get("/api/" + path).json
        self.assertNotIn("providers", guest)
        revision = next(l["revision"] for l in guest["lines"] if l["source"] == "custom")
        self.assertEqual(self.post(path, **data).status_code, 409)
        self.as_user(2)
        progress = dict(source="custom", accountId=2, label="第1集", seconds=61, revision=revision)
        self.assertEqual(self.post("episode-progress/"+key, **progress).status_code, 200)
        self.assertEqual(self.client.get("/api/history").json["items"][0]["seconds"], 61)
        self.assertEqual(self.client.get("/api/"+path).json["progress"]["label"], "第1集")
        self.assertIsNone(self.guest.get("/api/"+path).json["progress"])
        self.as_user(3)
        self.assertEqual(self.post("episode-progress/"+key, **progress).status_code, 401)
        self.as_user(1)
        self.assertEqual(self.post(path, source="custom",revision=revision,action="remove").status_code,200)
        self.as_user(2)
        self.assertEqual(self.post("episode-progress/"+key, **progress).status_code,409)
        self.assertIsNone(self.client.get("/api/"+path).json["progress"])
