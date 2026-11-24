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

    def test_browser_policy_and_private_responses(self):
        for path in ["/", "/api/session", "/missing"]:
            with self.client.get(path) as response:
                policy = response.headers["Content-Security-Policy"]
                for directive in ["script-src 'self'", "style-src 'self'", "frame-ancestors 'none'", "base-uri 'none'"]:
                    self.assertIn(directive, policy.split("; "))
                self.assertNotIn("unsafe-inline", policy)
                self.assertEqual(response.headers["X-Frame-Options"], "DENY")
                self.assertIn("max-age=", response.headers["Strict-Transport-Security"])
                if path.startswith("/api/"):
                    self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_account_limits_cover_aliases_and_reauthentication(self):
        challenge, code = self.request_code("reader@example.test")
        ticket = self.post("verify-email", challenge=challenge, code=code).json["ticket"]
        self.post("register", ticket=ticket, username="reader", password="reader-password")
        with patch("server.app.check_password_hash", return_value=False) as check:
            for i in range(15):
                identity = "reader" if i % 2 else "reader@example.test"
                self.assertEqual(self.post("login", identity=identity, password="wrong").status_code, 401)
            self.assertEqual(self.post("login", identity="READER", password="wrong").status_code, 429)
            for _ in range(5):
                self.assertEqual(self.post("account", username="new-reader", currentPassword="wrong").status_code, 403)
            self.assertEqual(self.post("account", username="new-reader", currentPassword="wrong").status_code, 429)
            self.assertEqual(check.call_count, 20)

    def test_login_uses_credentials_current_at_session_creation(self):
        challenge, code = self.request_code("reader@example.test")
        ticket = self.post("verify-email", challenge=challenge, code=code).json["ticket"]
        self.post("register", ticket=ticket, username="reader", password="reader-password")
        self.post("logout")

        def simultaneous_update(*args):
            with closing(sqlite3.connect(self.dbfile)) as conn, conn:
                conn.execute("UPDATE accounts SET password_hash='updated-hash' WHERE username='reader'")
            return True

        with patch("server.app.check_password_hash", side_effect=simultaneous_update):
            self.assertEqual(self.post("login", identity="reader", password="reader-password").status_code, 401)
        self.assertIsNone(self.client.get("/api/session").json["user"])
