import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from server.app import create_app


class AccountsTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.dbfile = str(Path(directory.name) / "accounts.db")
        app = create_app({"TESTING": True, "DATABASE": self.dbfile, "PUBLIC_ORIGIN": "https://example.test",
                          "AUTH_SECRET": "x" * 48, "SMTP_FROM": "sender@example.test", "SMTP_HOST": "smtp.example.test"})
        self.client = app.test_client()
        mail = patch("server.app.send_code")
        self.mail = mail.start()
        self.addCleanup(mail.stop)

    def post(self, endpoint, **data):
        return self.client.post("/api/" + endpoint, json=data, headers={"Origin": "https://example.test"})

    def request_code(self, email):
        result = self.post("email-code", email=email)
        self.assertEqual(result.status_code, 200)
        self.assertNotIn("code", result.json)
        return result.json["challenge"], self.mail.call_args.args[-1]

    def test_verification_registration_and_renaming(self):
        challenge, code = self.request_code("Reader@Example.test")
        self.assertEqual(self.post("email-code", email="reader@example.test").status_code, 429)
        params = {"username": "阿泽", "password": "rollercoaster"}
        self.assertEqual(self.post("register", **params).status_code, 410)
        ticket = self.post("verify-email", challenge=challenge, code=code).json["ticket"]
        self.assertEqual(self.post("verify-email", challenge=challenge, code=code).status_code, 400)
        for name in "罗硬金文鹏龙飞鲨任虎马":
            self.assertEqual(self.post("register", ticket=ticket, username=name, password=params["password"]).status_code, 400)
        signed = self.post("register", ticket=ticket, **params)
        self.assertEqual(signed.json["user"]["username"], "阿泽")
        self.assertIn("HttpOnly", signed.headers["Set-Cookie"])
        self.assertIn("Secure", signed.headers["Set-Cookie"])
        self.assertEqual(self.post("register", ticket=ticket, **params).status_code, 410)
        for identity in ["阿泽", "READER@example.test"]:
            self.assertEqual(self.post("logout").status_code, 200)
            self.assertIsNone(self.client.get("/api/session").json["user"])
            self.assertEqual(self.post("login", identity=identity, password=params["password"]).status_code, 200)
        old_cookie = self.client.get_cookie("luoban_session").value
        update = self.post("account", username="星星", currentPassword=params["password"], password="new-password")
        self.assertEqual(update.json["user"]["username"], "星星")
        self.client.set_cookie("luoban_session", old_cookie)
        self.assertIsNone(self.client.get("/api/session").json["user"])
        self.assertEqual(self.post("login", identity="星星", password="new-password").status_code, 200)
        with closing(sqlite3.connect(self.dbfile)) as conn, conn:
            self.assertNotEqual(conn.execute("SELECT password_hash FROM accounts").fetchone()[0], "new-password")

    def test_expired_codes_and_attempt_limits(self):
        challenge, code = self.request_code("timer@example.test")
        wrong = "999999" if code != "999999" else "111111"
        for _ in range(5):
            self.assertEqual(self.post("verify-email", challenge=challenge, code=wrong).status_code, 400)
        self.assertEqual(self.post("verify-email", challenge=challenge, code=code).status_code, 400)
        new_challenge, new_code = self.request_code("another@example.test")
        with closing(sqlite3.connect(self.dbfile)) as conn, conn:
            conn.execute("UPDATE challenges SET expires=0")
        self.assertEqual(self.post("verify-email", challenge=new_challenge, code=new_code).status_code, 400)

    def test_send_failure_and_origin(self):
        self.mail.side_effect = OSError("delivery failed")
        self.assertEqual(self.post("email-code", email="reader@example.test").status_code, 503)
        with closing(sqlite3.connect(self.dbfile)) as conn, conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM challenges").fetchone()[0], 0)
        self.assertEqual(self.client.post("/api/logout", json={}, headers={"Origin": "https://other.test"}).status_code, 403)
