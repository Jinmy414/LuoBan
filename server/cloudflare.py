"""Cloudflare Turnstile and the fixed Workers AI anime recommendation endpoint."""
import json
import re
import secrets
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from flask import jsonify, render_template, request
from itsdangerous import BadSignature, URLSafeTimedSerializer

VISIT_AGE = 12 * 60 * 60
MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
PROMPTS = json.loads((Path(__file__).resolve().parents[1] / "assets" / "anime-prompts.json").read_text(encoding="utf-8"))


def post_json(url, payload, headers=None, timeout=8):
    req = Request(url, data=json.dumps(payload, ensure_ascii=False).encode(),
                  headers={"Content-Type": "application/json", **(headers or {})})
    with urlopen(req, timeout=timeout) as response:
        return json.load(response)


def verify_entry(cfg):
    token = request.json.get("turnstileToken")
    if not isinstance(token, str) or not 1 <= len(token) <= 2048:
        return jsonify(error="请先完成人机验证。"), 403
    try:
        verdict = post_json("https://challenges.cloudflare.com/turnstile/v0/siteverify",
                            {"secret": cfg["TURNSTILE_SECRET"], "response": token})
    except (OSError, ValueError):
        return jsonify(error="暂时无法核验，请稍后重试。"), 503
    if not (isinstance(verdict, dict) and verdict.get("success") is True and
            verdict.get("hostname") == urlsplit(cfg["PUBLIC_ORIGIN"]).hostname and
            verdict.get("action") == "site_entry"):
        return jsonify(error="人机验证未通过或已过期，请重试。"), 403
    return None


def install(app, within_limit):
    cfg = app.config
    if bool(cfg["TURNSTILE_SITE_KEY"]) != bool(cfg["TURNSTILE_SECRET"]):
        raise ValueError("Configure both Turnstile keys together")
    if cfg["CF_AI_TOKEN"] and not re.fullmatch(r"[a-f0-9]{32}", cfg["CF_ACCOUNT_ID"]):
        raise ValueError("A valid Cloudflare account ID is required for Workers AI")

    secure = urlsplit(cfg["PUBLIC_ORIGIN"]).scheme == "https"
    cookie = "__Host-luoban_visit" if secure else "luoban_visit"
    visits = URLSafeTimedSerializer(cfg["AUTH_SECRET"], salt="luoban-site-entry-v1")

    @app.before_request
    def require_visit():
        if not cfg["TURNSTILE_SECRET"] or request.endpoint == "complete_site_entry":
            return None
        page = request.path in {"/", "/index.html", "/admin/traffic"}
        if not page and not request.path.startswith("/api/"):
            return None
        proof = request.cookies.get(cookie)
        if proof:
            try:
                visits.loads(proof, max_age=VISIT_AGE)
                return None
            except BadSignature:
                pass
        if page:
            return render_template("site_entry.html", site_key=cfg["TURNSTILE_SITE_KEY"])
        return jsonify(code="SITE_ENTRY_REQUIRED", error="请先完成网站入口验证。"), 403

    @app.post("/api/site-entry")
    def complete_site_entry():
        if not cfg["TURNSTILE_SECRET"]:
            return jsonify(verified=True)
        if not within_limit("entry:" + request.remote_addr, 60, 600):
            return jsonify(error="验证请求过于频繁，请稍后重试。"), 429
        denied = verify_entry(cfg)
        if denied:
            return denied
        response = jsonify(verified=True)
        response.set_cookie(cookie, visits.dumps(secrets.token_urlsafe(16)), secure=secure,
                            httponly=True, samesite="Lax", path="/")
        return response

    @app.get("/api/cloudflare-config")
    def public_config():
        return jsonify(llama=bool(cfg["CF_AI_TOKEN"]))

    @app.post("/api/anime-recommend")
    def recommend():
        if not cfg["CF_AI_TOKEN"]:
            return jsonify(fallback=True)
        data = request.json
        phase = data.get("phase", "recommend")
        if phase not in ("conversation", "recommend"):
            return jsonify(error="无法识别这条聊天请求。"), 400
        fields = [("question", 360), ("history", 4000)]
        if phase == "recommend":
            fields.append(("titles", 900))
        if not all(isinstance(data.get(k), str) and len(data[k]) <= n for k, n in fields) or not data["question"].strip():
            return jsonify(error="请检查消息长度后重试。"), 400
        try:
            history = json.loads(data["history"])
        except ValueError:
            history = None
        if not isinstance(history, list):
            return jsonify(error="无法读取最近对话。"), 400
        message = {"最近对话": history, "当前消息": data["question"]}
        if phase == "recommend":
            query = data.get("query", data["question"])
            if not isinstance(query, str) or len(query) > 360 or not data["titles"].strip():
                return jsonify(error="请检查选片条件后重试。"), 400
            limit = data.get("limit", 2)
            if type(limit) is not int or limit not in (1, 2):
                return jsonify(error="单次可推荐一至两部作品。"), 400
            message.update(选片条件=query, 最多几部=limit, 候选片名=data["titles"])
        if not within_limit(f"ai-{phase}:" + request.remote_addr, 12, 600):
            return jsonify(error="聊天请求过于频繁，请稍后再试。"), 429
        query = json.dumps(message, ensure_ascii=False)
        try:
            result = post_json(f"https://api.cloudflare.com/client/v4/accounts/{cfg['CF_ACCOUNT_ID']}/ai/run/{MODEL}",
                               {"messages": [{"role": "system", "content": "\n".join(PROMPTS[phase])}, {"role": "user", "content": query}],
                                "max_tokens": 400, "temperature": 0.4, "response_format": {"type": "json_object"}},
                               {"Authorization": "Bearer " + cfg["CF_AI_TOKEN"]}, timeout=24)
            if isinstance(result, dict) and result.get("success") and isinstance(result.get("result"), dict):
                body = result["result"]
                answer = body.get("response")
                choices = body.get("choices")
                if isinstance(choices, list) and choices and isinstance(choices[0], dict):
                    message = choices[0].get("message")
                    if isinstance(message, dict) and message.get("content"):
                        answer = message["content"]
                if isinstance(answer, dict) and ("recommendations" in answer or "action" in answer):
                    answer = json.dumps(answer, ensure_ascii=False)
                if isinstance(answer, str) and answer.strip():
                    return jsonify(text=answer, model="Llama 3.3 70B")
        except (OSError, ValueError):
            pass
        return jsonify(fallback=True)
