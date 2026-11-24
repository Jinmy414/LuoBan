import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server.app import create_app


class CloudflareIntegrationTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.client = create_app({
            "TESTING": True, "DATABASE": str(Path(folder.name) / "test.sqlite"),
            "PUBLIC_ORIGIN": "https://example.test", "AUTH_SECRET": "x" * 48,
            "SMTP_FROM": "sender@example.test", "SMTP_HOST": "smtp.example.test",
            "TURNSTILE_SITE_KEY": "public-key", "TURNSTILE_SECRET": "private-widget-value",
            "CF_ACCOUNT_ID": "a" * 32, "CF_AI_TOKEN": "private-inference-value",
        }).test_client()
        self.query = dict(question="推荐运动番", titles="排球少年｜灌篮高手", history="[]")

    def post(self, path, **data):
        return self.client.post("/api/" + path, json=data, headers={"Origin": "https://example.test"})

    def verdict(self, action):
        return {"success": True, "hostname": "example.test", "action": action}

    def test_widget_is_public_and_keys_are_private(self):
        result = self.client.get("/api/cloudflare-config")
        self.assertEqual(result.json, {"siteKey": "public-key", "llama": True})
        policy = result.headers["Content-Security-Policy"]
        self.assertIn("script-src 'self' https://challenges.cloudflare.com", policy)
        self.assertIn("https://challenges.cloudflare.com", policy.split("frame-src")[1])

    @patch("server.app.send_code")
    @patch("server.cloudflare.post_json")
    def test_email_requires_matching_host_action_and_fresh_token(self, cloud, mail):
        email = "reader@example.test"
        self.assertEqual(self.post("email-code", email=email).status_code, 403)
        cloud.assert_not_called()
        for invalid in [{**self.verdict("email_code"), "hostname": "wrong.test"},
                        self.verdict("login"), {"success": False}]:
            cloud.return_value = invalid
            self.assertEqual(self.post("email-code", email=email, turnstileToken="test").status_code, 403)
        mail.assert_not_called()
        cloud.return_value = self.verdict("email_code")
        self.assertEqual(self.post("email-code", email=email, turnstileToken="fresh").status_code, 200)
        mail.assert_called_once()
        self.assertEqual(cloud.call_args.args[1], {"secret": "private-widget-value", "response": "fresh"})

    @patch("server.app.check_password_hash")
    @patch("server.cloudflare.post_json", side_effect=TimeoutError)
    def test_login_stops_on_verification_outage(self, cloud, password):
        self.assertEqual(self.post("login", identity="u", password="test", turnstileToken="test").status_code, 503)
        password.assert_not_called()

    @patch("server.cloudflare.post_json")
    def test_recommendation_checks_token_and_falls_back_on_model_outage(self, cloud):
        self.assertEqual(self.post("anime-recommend", **self.query).status_code, 403)
        cloud.return_value = self.verdict("login")
        self.assertEqual(self.post("anime-recommend", **self.query, turnstileToken="wrong").status_code, 403)
        cloud.side_effect = [self.verdict("anime_chat"), OSError("quota")]
        self.assertEqual(self.post("anime-recommend", **self.query, turnstileToken="ok").json, {"fallback": True})
        cloud.side_effect = [self.verdict("anime_chat"), {"success": True, "result": {"response": "推荐结果"}}]
        res = self.post("anime-recommend", **self.query, turnstileToken="ok")
        self.assertEqual(res.json, {"model": "Llama 3.3 70B", "text": "推荐结果"})
        url, body, headers = cloud.call_args.args
        self.assertIn("/ai/run/@cf/meta/llama-3.3-70b", url)
        self.assertEqual(headers["Authorization"], "Bearer private-inference-value")
        self.assertNotIn("turnstileToken", str(body))
