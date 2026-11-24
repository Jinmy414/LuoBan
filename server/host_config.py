"""Prepare private PythonAnywhere settings locally on the hosting account."""
import argparse
import getpass
import json
import os
import re
import secrets
import sqlite3
from contextlib import closing
import tempfile
from pathlib import Path

SETTINGS = Path.home() / ".config" / "luoban" / "settings.json"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", required=True)
    parser.add_argument("--super-admin-id", type=int, help="verified account ID of the site owner")
    parser.add_argument("--mail", action="store_true", help="configure the Brevo sender interactively")
    parser.add_argument("--turnstile", action="store_true", help="set the site's widget keys")
    parser.add_argument("--workers-ai", action="store_true", help="set the account and a Workers AI token")
    args = parser.parse_args()
    if not args.origin.startswith("https://"):
        parser.error("The public website requires HTTPS")
    settings = json.loads(SETTINGS.read_text()) if SETTINGS.exists() else {"AUTH_SECRET": secrets.token_urlsafe(48)}
    settings["PUBLIC_ORIGIN"] = args.origin.rstrip("/")
    if args.super_admin_id is not None:
        if args.super_admin_id < 1:
            parser.error("Specify a registered account ID")
        database = settings.get("DATABASE", str(Path(__file__).resolve().parents[1] / "instance" / "accounts.sqlite3"))
        with closing(sqlite3.connect(database)) as conn, conn:
            if not conn.execute("SELECT 1 FROM accounts WHERE id=?", (args.super_admin_id,)).fetchone():
                parser.error("That account does not exist in the configured database")
            if not settings.get("SUPER_ADMIN_ID") and settings.get("ADMIN_EMAIL"):
                conn.execute("CREATE TABLE IF NOT EXISTS editors (user_id INTEGER PRIMARY KEY REFERENCES accounts(id))")
                conn.execute("INSERT OR IGNORE INTO editors SELECT id FROM accounts WHERE email=?", (settings["ADMIN_EMAIL"],))
        settings["SUPER_ADMIN_ID"] = args.super_admin_id
    if args.mail:
        sender = input("Verified Brevo sender email: ").strip()
        key = getpass.getpass("Brevo API key (hidden): ").strip()
        if not sender or not key:
            parser.error("Both sender and key are required")
        settings.update(SMTP_FROM=sender, BREVO_API_KEY=key)
    if args.turnstile:
        site = input("Turnstile site key: ").strip()
        secret = getpass.getpass("Turnstile secret (hidden): ").strip()
        if not site or not secret:
            parser.error("Both Turnstile keys are required")
        settings.update(TURNSTILE_SITE_KEY=site, TURNSTILE_SECRET=secret)
    if args.workers_ai:
        account = input("Cloudflare account ID: ").strip().lower()
        token = getpass.getpass("Workers AI API token (hidden): ").strip()
        if not re.fullmatch(r"[a-f0-9]{32}", account) or not token:
            parser.error("Valid account ID and Workers AI token required")
        settings.update(CF_ACCOUNT_ID=account, CF_AI_TOKEN=token)
    SETTINGS.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile("w", dir=SETTINGS.parent, delete=False) as dest:
        json.dump(settings, dest)
    os.replace(dest.name, SETTINGS)
    print("Private settings saved. Reload the website from the Web tab.")


if __name__ == "__main__":
    main()
