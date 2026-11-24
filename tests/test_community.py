import base64
import io
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
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
        with sqlite3.connect(path) as conn:
            for i in range(1, 4):
                conn.execute("INSERT INTO accounts VALUES (?,?,?,?,?)", (i, f"user{i}", f"user{i}", f"{i}@example.test", "unused"))
                conn.execute("INSERT INTO sessions VALUES (?,?,?)", (digest(str(i)), i, 9999999999))

    def post(self, path, **data):
        return self.client.post("/api/"+path, json=data, headers={"Origin":"https://example.test"})

    def as_user(self, user):
        self.client.set_cookie(COOKIE, str(user))

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
