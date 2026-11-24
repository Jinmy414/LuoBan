"""Same-origin email authentication for the Luoban catalogue."""
import hashlib
import hmac
import json
import os
import re
import secrets
import smtplib
import sqlite3
import ssl
import time
import unicodedata
from contextlib import closing
from email.message import EmailMessage
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from flask import Flask, abort, g, jsonify, request, send_from_directory
from werkzeug.security import check_password_hash, generate_password_hash

from . import community, episodes

ROOT = Path(__file__).resolve().parents[1]
IMPORTED = set("罗硬金文鹏龙飞鲨任虎马")
SYSTEM_NAMES = {"admin", "jinmy414", "罗瓣社区", "罗瓣管理员", "__proto__", "constructor", "prototype"}
COOKIE = "luoban_session"
SESSION_AGE = 14 * 86400
SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
 id INTEGER PRIMARY KEY, username TEXT NOT NULL, name_key TEXT UNIQUE NOT NULL,
 email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS member_claims (
 name TEXT PRIMARY KEY, hash TEXT, expires INTEGER NOT NULL, owner INTEGER UNIQUE REFERENCES accounts(id)
);
CREATE TABLE IF NOT EXISTS editors (user_id INTEGER PRIMARY KEY REFERENCES accounts(id));
CREATE TABLE IF NOT EXISTS sessions (
 digest TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS challenges (
 id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, code_digest TEXT NOT NULL,
 expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tickets (digest TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS limits (bucket TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires INTEGER NOT NULL);
"""


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def send_code(config, email, code):
    subject = "罗瓣邮箱验证码"
    body = f"你的罗瓣验证码是 {code}，10 分钟内有效。\n如果你没有申请注册，可以忽略此邮件。"
    if config["BREVO_API_KEY"]:
        message = {"sender": {"name": "罗瓣", "email": config["SMTP_FROM"]}, "to": [{"email": email}],
                   "subject": subject, "textContent": body}
        outgoing = Request("https://api.brevo.com/v3/smtp/email", data=json.dumps(message).encode(),
                           headers={"api-key": config["BREVO_API_KEY"], "Content-Type": "application/json"})
        with urlopen(outgoing, timeout=8):
            return
    host = config["SMTP_HOST"]
    if not host or not config["SMTP_FROM"]:
        raise OSError("SMTP is not configured")
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"], msg["To"] = config["SMTP_FROM"], email
    msg.set_content(body)
    context = ssl.create_default_context()
    mode = config["SMTP_SECURITY"]
    if mode == "ssl":
        connection = smtplib.SMTP_SSL(host, config["SMTP_PORT"], context=context, timeout=8)
    else:
        connection = smtplib.SMTP(host, config["SMTP_PORT"], timeout=8)
    with connection as smtp:
        if mode == "starttls":
            smtp.starttls(context=context)
        if config["SMTP_USER"]:
            smtp.login(config["SMTP_USER"], config["SMTP_PASSWORD"])
        smtp.send_message(msg)


def create_app(overrides=None):
    app = Flask(__name__, static_folder=None)
    app.config.from_mapping(
        MAX_CONTENT_LENGTH=4096,
        DATABASE=os.getenv("DATABASE", str(ROOT / "instance" / "accounts.sqlite3")),
        PUBLIC_ORIGIN=os.getenv("PUBLIC_ORIGIN", "http://localhost:8000").rstrip("/"),
        AUTH_SECRET=os.getenv("AUTH_SECRET", ""),
        BREVO_API_KEY=os.getenv("BREVO_API_KEY", ""),
        SMTP_HOST=os.getenv("SMTP_HOST", ""), SMTP_PORT=int(os.getenv("SMTP_PORT", "587")),
        SMTP_FROM=os.getenv("SMTP_FROM", ""), SMTP_USER=os.getenv("SMTP_USER", ""),
        SMTP_PASSWORD=os.getenv("SMTP_PASSWORD", ""), SMTP_SECURITY=os.getenv("SMTP_SECURITY", "starttls"),
        SUPER_ADMIN_ID=os.getenv("SUPER_ADMIN_ID", ""),
        ADMIN_EMAIL=os.getenv("ADMIN_EMAIL", "").strip().lower(),
    )
    if overrides:
        app.config.update(overrides)
    cfg = app.config
    origin = urlsplit(cfg["PUBLIC_ORIGIN"])
    secure = origin.scheme == "https"
    if not origin.netloc or origin.path or (not secure and not (
        origin.scheme == "http" and origin.hostname in {"localhost", "127.0.0.1", "::1"}
    )):
        raise ValueError("PUBLIC_ORIGIN must be an HTTPS origin, or HTTP on loopback")
    if len(cfg["AUTH_SECRET"]) < 32:
        raise ValueError("Set AUTH_SECRET to at least 32 random characters")
    if cfg["SMTP_SECURITY"] not in {"starttls", "ssl"} and not (
        cfg["SMTP_SECURITY"] == "plain" and cfg["SMTP_HOST"] in {"127.0.0.1", "localhost", "::1"} and not secure
    ):
        raise ValueError("SMTP_SECURITY must be starttls or ssl (plain only for local testing)")
    Path(cfg["DATABASE"]).parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(cfg["DATABASE"], timeout=10)) as initial:
        initial.executescript(SCHEMA + community.SCHEMA)
        episodes.install_catalogues(initial, ROOT / "server" / "episode-catalogues.json")

    def db():
        if "db" not in g:
            g.db = sqlite3.connect(cfg["DATABASE"], timeout=10)
            g.db.row_factory = sqlite3.Row
        return g.db

    @app.teardown_appcontext
    def close_db(_):
        if "db" in g:
            g.db.close()

    @app.before_request
    def validate_request():
        if request.path.startswith("/api/") and request.method == "POST":
            if request.path in {"/api/account", "/api/submissions", "/api/reviews"} or request.path.startswith("/api/episodes/"):
                request.max_content_length = 3_000_000
            if request.headers.get("Origin") != cfg["PUBLIC_ORIGIN"] or not request.is_json:
                return fail("请从罗瓣网站重新打开此页面。", 403)
            if not isinstance(request.get_json(silent=True), dict):
                return fail("请检查表单后重试。")

    @app.errorhandler(413)
    def oversized_payload(_):
        return fail("提交的数据太大，请缩小后重试。", 413)

    @app.after_request
    def response_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def fail(message, status=400):
        return jsonify(error=message), status

    def field(name):
        value = request.json.get(name)
        return value if isinstance(value, str) else ""

    def now():
        return int(time.time())

    def within_limit(key, maximum, seconds):
        # Commit each attempt independently, including ones that later fail validation.
        with db() as conn:
            conn.execute("DELETE FROM limits WHERE expires <= ?", (now(),))
            return bool(conn.execute("""
                INSERT INTO limits VALUES (?,1,?) ON CONFLICT(bucket)
                DO UPDATE SET hits=hits+1 WHERE hits < ? RETURNING hits
            """, (digest(key), now() + seconds, maximum)).fetchone())

    def code_hash(challenge, code):
        return hmac.new(cfg["AUTH_SECRET"].encode(), (challenge + ":" + code).encode(), "sha256").hexdigest()

    def public_user(row):
        if str(row["id"]) == str(cfg["SUPER_ADMIN_ID"]):
            role = "superadmin"
        elif db().execute("SELECT 1 FROM editors WHERE user_id=?", (row["id"],)).fetchone():
            role = "admin"
        elif not cfg["SUPER_ADMIN_ID"] and row["email"] == cfg["ADMIN_EMAIL"]:
            role = "admin"
        else:
            role = "user"
        return dict(id=row["id"], username=row["username"], role=role)

    def active_user():
        return db().execute("""
            SELECT a.* FROM accounts a JOIN sessions s ON s.user_id=a.id
            WHERE s.digest=? AND s.expires>?
        """, (digest(request.cookies.get(COOKIE, "")), now())).fetchone()

    def start_session(row):
        token = secrets.token_urlsafe(32)
        db().execute("DELETE FROM sessions WHERE expires <= ? OR digest=?", (now(), digest(request.cookies.get(COOKIE, ""))))
        db().execute("INSERT INTO sessions VALUES (?,?,?)", (digest(token), row["id"], now() + SESSION_AGE))
        response = jsonify(user=public_user(row))
        response.set_cookie(COOKIE, token, max_age=SESSION_AGE, secure=secure, httponly=True, samesite="Lax", path="/")
        return response

    def check_name(username, email):
        if not re.fullmatch(r"[\w-]{1,20}", username):
            return "用户名可用 1 至 20 个汉字、字母、数字、短横线或下划线。"
        if username in IMPORTED:
            return "这个单字名已为原名单成员保留，请换一个用户名。"
        if username.casefold() in SYSTEM_NAMES and not (username == "admin" and email == cfg["ADMIN_EMAIL"]):
            return "这个用户名已保留，请换一个。"
        return None

    def valid_claim(username, code):
        if username not in IMPORTED or not code:
            return False
        row = db().execute("SELECT hash FROM member_claims WHERE name=? AND owner IS NULL AND expires>?",
                           (username, now())).fetchone()
        return bool(row and hmac.compare_digest(row["hash"], digest(code.strip().upper())))

    @app.route("/api/member-invites", methods=["GET", "POST"])
    def member_invites():
        with db() as conn:
            if request.method == "POST":
                conn.execute("BEGIN IMMEDIATE")
            user = active_user()
            if not user or public_user(user)["role"] != "superadmin":
                return fail("只有超级管理员可以管理认领码。", 403)
            if request.method == "POST":
                name = field("username")
                if name not in IMPORTED:
                    return fail("请选择名单中的成员。")
                code = secrets.token_hex(8).upper()
                changed = conn.execute("""INSERT INTO member_claims(name,hash,expires) VALUES (?,?,?)
                    ON CONFLICT(name) DO UPDATE SET hash=excluded.hash, expires=excluded.expires
                    WHERE owner IS NULL RETURNING name""", (name, digest(code), now()+7*86400)).fetchone()
                if not changed:
                    return fail("这位成员已完成绑定。", 409)
                return jsonify(username=name, code=code)
            rows = {r["name"]: r for r in conn.execute("SELECT name, expires, owner FROM member_claims")}
            def status(name):
                row = rows.get(name)
                if not row:
                    return "available"
                if row["owner"] is not None:
                    return "claimed"
                return "issued" if row["expires"] > now() else "expired"
            return jsonify(members=[dict(username=name, status=status(name)) for name in "罗硬金文鹏龙飞鲨任虎马"])

    @app.post("/api/email-code")
    def email_code():
        if not cfg["SMTP_FROM"] or not (cfg["BREVO_API_KEY"] or cfg["SMTP_HOST"]):
            return fail("站点尚未启用邮件服务，暂时无法注册。", 503)
        email = field("email").strip().lower()
        if len(email) > 254 or not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+", email):
            return fail("请输入有效的邮箱地址。")
        if not within_limit("mail-ip:" + request.remote_addr, 25, 3600):
            return fail("发送过于频繁，请稍后再试。", 429)
        if "claimCode" in request.json and not valid_claim(field("username"), field("claimCode")):
            return fail("单字名或认领码无效，请向站长核对。")
        if not within_limit("mail:" + email, 1, 60):
            return fail("请在上次请求 60 秒后重试。", 429)
        challenge, code = secrets.token_urlsafe(24), f"{secrets.randbelow(1000000):06}"
        with db() as conn:
            conn.execute("DELETE FROM challenges WHERE expires<=? OR email=?", (now(), email))
            conn.execute("INSERT INTO challenges VALUES (?,?,?,?,0)", (challenge, email, code_hash(challenge, code), now() + 600))
        try:
            send_code(cfg, email, code)
        except (OSError, smtplib.SMTPException):
            with db() as conn:
                conn.execute("DELETE FROM challenges WHERE id=?", (challenge,))
            return fail("验证邮件暂时无法发送，请稍后再试。", 503)
        return jsonify(challenge=challenge, retryAfter=60)

    @app.post("/api/verify-email")
    def verify_email():
        challenge, code = field("challenge"), field("code")
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM challenges WHERE id=? AND expires>? AND attempts<5", (challenge, now())).fetchone()
            if not row:
                return fail("验证码已失效，请重新发送。")
            if not hmac.compare_digest(row["code_digest"], code_hash(challenge, code)):
                conn.execute("UPDATE challenges SET attempts=attempts+1 WHERE id=?", (challenge,))
                return fail("验证码有误，请核对邮件中的六位数字。")
            conn.execute("DELETE FROM challenges WHERE id=?", (challenge,))
            if conn.execute("SELECT 1 FROM accounts WHERE email=?", (row["email"],)).fetchone():
                return fail("这个邮箱已经注册，请使用密码登录。", 409)
            ticket = secrets.token_urlsafe(32)
            conn.execute("DELETE FROM tickets WHERE expires<=? OR email=?", (now(), row["email"]))
            conn.execute("INSERT INTO tickets VALUES (?,?,?)", (digest(ticket), row["email"], now() + 900))
        return jsonify(ticket=ticket)

    @app.post("/api/register")
    def register():
        ticket_hash = digest(field("ticket"))
        username = unicodedata.normalize("NFKC", field("username").strip())
        password = field("password")
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            proof = conn.execute("SELECT email FROM tickets WHERE digest=? AND expires>?", (ticket_hash, now())).fetchone()
            if not proof:
                return fail("邮箱验证已过期，请重新获取验证码。", 410)
            claiming = "claimCode" in request.json
            if claiming and not valid_claim(username, field("claimCode")):
                return fail("单字名或认领码已失效，请向站长核对。")
            error = None if claiming else check_name(username, proof["email"])
            if error or not 8 <= len(password) <= 128:
                return fail(error or "密码长度需为 8 至 128 个字符。")
            try:
                row = conn.execute("INSERT INTO accounts(username,name_key,email,password_hash) VALUES (?,?,?,?) RETURNING *",
                    (username, username.casefold(), proof["email"], generate_password_hash(password))).fetchone()
            except sqlite3.IntegrityError:
                return fail("用户名或邮箱已经被使用。", 409)
            if claiming:
                conn.execute("UPDATE member_claims SET owner=?, hash=NULL, expires=0 WHERE name=?", (row["id"], username))
            conn.execute("DELETE FROM tickets WHERE digest=?", (ticket_hash,))
            return start_session(row)

    @app.post("/api/login")
    def login():
        identity = unicodedata.normalize("NFKC", field("identity").strip()).casefold()
        if not within_limit("login-ip:" + request.remote_addr, 100, 900) or not within_limit("login:" + identity, 15, 900):
            return fail("尝试次数过多，请在 15 分钟后再试。", 429)
        row = db().execute("SELECT * FROM accounts WHERE name_key=? OR email=?", (identity, identity)).fetchone()
        if not row or not check_password_hash(row["password_hash"], field("password")):
            return fail("用户名、邮箱或密码不正确。", 401)
        with db():
            return start_session(row)

    @app.get("/api/session")
    def session_info():
        row = active_user()
        return jsonify(user=public_user(row) if row else None)

    @app.post("/api/logout")
    def logout():
        with db() as conn:
            conn.execute("DELETE FROM sessions WHERE digest=?", (digest(request.cookies.get(COOKIE, "")),))
        response = jsonify(user=None)
        response.delete_cookie(COOKIE, path="/", secure=secure, httponly=True, samesite="Lax")
        return response

    @app.post("/api/account")
    def edit_account():
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = active_user()
            if not row:
                return fail("请重新登录后再修改账号。", 401)
            credentials_changed = field("username").strip() != row["username"] or bool(field("password"))
            if (credentials_changed or "avatar" not in request.json) and not check_password_hash(row["password_hash"], field("currentPassword")):
                return fail("当前密码不正确。", 403)
            username = unicodedata.normalize("NFKC", field("username").strip())
            error = check_name(username, row["email"]) if username != row["username"] else None
            password = field("password")
            if error or (password and not 8 <= len(password) <= 128):
                return fail(error or "新密码长度需为 8 至 128 个字符。")
            avatar = None
            if "avatar" in request.json:
                try:
                    avatar = community.image_bytes(request.json["avatar"], avatar=True)
                except ValueError as exc:
                    return fail(str(exc))
            try:
                updated = conn.execute("UPDATE accounts SET username=?,name_key=?,password_hash=? WHERE id=? RETURNING *",
                    (username, username.casefold(), generate_password_hash(password) if password else row["password_hash"], row["id"])).fetchone()
            except sqlite3.IntegrityError:
                return fail("这个用户名已经被使用。", 409)
            if avatar is not None:
                conn.execute("INSERT OR REPLACE INTO avatars VALUES (?,?)", (row["id"], avatar))
            if password:
                conn.execute("DELETE FROM sessions WHERE user_id=?", (row["id"],))
            return start_session(updated)

    @app.route("/api/editors", methods=["GET", "POST"])
    def manage_editors():
        with db() as conn:
            if request.method == "POST":
                conn.execute("BEGIN IMMEDIATE")
            actor = active_user()
            if not actor or public_user(actor)["role"] != "superadmin":
                return fail("只有超级管理员可以设置管理员。", 403)
            if request.method == "POST":
                target, grant = request.json.get("id"), request.json.get("grant")
                if type(target) is not int or type(grant) is not bool or target == actor["id"]:
                    return fail("请选择其他已注册账号。")
                if not conn.execute("SELECT 1 FROM accounts WHERE id=?", (target,)).fetchone():
                    return fail("账号不存在。", 404)
                if grant:
                    conn.execute("INSERT OR IGNORE INTO editors VALUES (?)", (target,))
                else:
                    conn.execute("DELETE FROM editors WHERE user_id=?", (target,))
            rows = conn.execute("SELECT id, username, email FROM accounts ORDER BY username")
            return jsonify(users=[public_user(row) for row in rows])

    community.mount(app, db, active_user, public_user, now, fail, ROOT)

    @app.get("/")
    def index():
        return send_from_directory(ROOT, "index.html")

    @app.get("/assets/<path:name>")
    def assets(name):
        return send_from_directory(ROOT / "assets", name)

    @app.get("/<name>")
    def site_file(name):
        if name not in {"app.js", "auth.js", "styles.css", "index.html"}:
            abort(404)
        return send_from_directory(ROOT, name)

    return app
