import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server.app import create_app
from server.cloudflare import VISIT_AGE


class CloudflareIntegrationTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.client = create_app({
            "TESTING": True, "DATABASE": str(Path(folder.name) / "accounts.sqlite"),
            "PUBLIC_ORIGIN": "https://example.test", "AUTH_SECRET": "x" * 48,
            "SMTP_FROM": "sender@example.test", "SMTP_HOST": "smtp.example.test",
            "TURNSTILE_SITE_KEY": "public-key", "TURNSTILE_SECRET": "private-widget-value",
            "CF_ACCOUNT_ID": "a" * 32, "CF_AI_TOKEN": "private-inference-value",
        }).test_client()
        self.query = dict(question="推荐运动番", titles="排球少年｜灌篮高手", history="[]")

    def post(self, path, **data):
        return self.client.post("/api/" + path, json=data, headers={"Origin": "https://example.test"})

    def verdict(self):
        return {"success": True, "hostname": "example.test", "action": "site_entry"}

    def test_first_navigation_gets_only_entry_and_api_waits(self):
        for path in ["/", "/index.html"]:
            result = self.client.get(path)
            self.assertIn('data-site-key="public-key"', result.text)
            self.assertNotIn("animation-works.js", result.text)
            self.assertNotIn("private-widget-value", result.text)
            self.assertEqual(result.headers["Cache-Control"], "no-store")
            self.assertIn("https://challenges.cloudflare.com", result.headers["Content-Security-Policy"].split("frame-src")[1])
        for path in ["session", "works", "cloudflare-config"]:
            self.assertEqual(self.client.get("/api/" + path).json["code"], "SITE_ENTRY_REQUIRED")
        self.assertEqual(self.post("login", identity="reader", password="hello").status_code, 403)
        self.assertEqual(self.post("anime-recommend", **self.query).status_code, 403)
        with self.client.get("/assets/site-entry.js") as result:
            self.assertEqual(result.status_code, 200)

    @patch("server.cloudflare.post_json")
    def test_entry_validates_host_action_and_provider_availability(self, cloud):
        self.assertEqual(self.post("site-entry").status_code, 403)
        cloud.assert_not_called()
        for invalid in [{**self.verdict(), "hostname": "wrong.test"}, {**self.verdict(), "action": "login"},
                        {"success": False}]:
            cloud.return_value = invalid
            result = self.post("site-entry", turnstileToken="example")
            self.assertEqual(result.status_code, 403)
            self.assertNotIn("Set-Cookie", result.headers)
        cloud.side_effect = TimeoutError()
        self.assertEqual(self.post("site-entry", turnstileToken="test").status_code, 503)
        self.assertEqual(self.client.get("/api/session").status_code, 403)

    @patch("server.app.send_code")
    @patch("server.cloudflare.post_json")
    def test_verified_visit_works_across_routes_and_ordinary_actions(self, cloud, mail):
        cloud.return_value = self.verdict()
        result = self.post("site-entry", turnstileToken="valid")
        self.assertTrue(result.json["verified"])
        for flag in ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]:
            self.assertIn(flag, result.headers["Set-Cookie"])
        self.assertNotIn("Max-Age", result.headers["Set-Cookie"])
        for path in ["/", "/index.html"]:
            with self.client.get(path) as result:
                self.assertIn("animation-works.js", result.text)
                self.assertNotIn("entryWidget", result.text)
                self.assertEqual(result.headers["Cache-Control"], "no-store")
        self.assertEqual(self.client.get("/api/cloudflare-config").json, {"llama": True})
        self.assertEqual(self.post("email-code", email="reader@example.test").status_code, 200)
        mail.assert_called_once()
        self.assertEqual(self.post("login", identity="unknown", password="test").status_code, 401)
        cloud.assert_called_once()
        cloud.return_value = {"success": True, "result": {"choices": [{"message": {"content": "推荐结果"}}]}}
        self.assertEqual(self.post("anime-recommend", **self.query).json, {"model": "Llama 3.3 70B", "text": "推荐结果"})
        url, body, headers = cloud.call_args.args
        self.assertIn("/ai/run/@cf/meta/llama-3.3-70b", url)
        self.assertEqual(headers["Authorization"], "Bearer private-inference-value")
        self.assertNotIn("turnstileToken", str(body))
        cloud.side_effect = OSError("quota")
        self.assertEqual(self.post("anime-recommend", **self.query).json, {"fallback": True})

    @patch("server.cloudflare.post_json")
    def test_conversation_reads_prior_reasons_without_requesting_titles(self, cloud):
        cloud.return_value = self.verdict()
        self.post("site-entry", turnstileToken="valid")
        history = [{"用户": "想看运动番", "推荐": [{"片名": "排球少年", "理由": "团队协作"}]}]
        decision = {"action": "reply", "reply": "因为你提到喜欢团队协作。"}
        cloud.return_value = {"success": True, "result": {"response": decision}}
        result = self.post("anime-recommend", phase="conversation", question="为什么给我这个作品",
                           history=json.dumps(history, ensure_ascii=False))
        self.assertEqual(json.loads(result.json["text"]), decision)
        messages = cloud.call_args.args[1]["messages"]
        self.assertEqual(json.loads(messages[1]["content"]), {"当前消息": "为什么给我这个作品", "最近对话": history})
        self.assertIn('"action":"reply"', messages[0]["content"])
        self.assertEqual(self.post("anime-recommend", phase="recommend", question="换一部", history="[]").status_code, 400)
        self.assertEqual(self.post("anime-recommend", phase="conversation", question="你好", history="null").status_code, 400)

    @patch("server.cloudflare.post_json")
    def test_visit_expires_and_requires_new_entry(self, cloud):
        cloud.return_value = self.verdict()
        with patch("itsdangerous.timed.TimestampSigner.get_timestamp", return_value=10000):
            self.assertTrue(self.post("site-entry", turnstileToken="test").json["verified"])
        with patch("itsdangerous.timed.TimestampSigner.get_timestamp", return_value=10000 + VISIT_AGE + 1):
            self.assertEqual(self.client.get("/api/session").status_code, 403)
            self.assertIn("entryWidget", self.client.get("/").text)
