"""Prepare private PythonAnywhere settings locally on the hosting account."""
import argparse
import getpass
import json
import os
import secrets
import tempfile
from pathlib import Path

SETTINGS = Path.home() / ".config" / "luoban" / "settings.json"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", required=True)
    parser.add_argument("--mail", action="store_true", help="configure the Brevo sender interactively")
    args = parser.parse_args()
    if not args.origin.startswith("https://"):
        parser.error("The public website requires HTTPS")
    settings = json.loads(SETTINGS.read_text()) if SETTINGS.exists() else {"AUTH_SECRET": secrets.token_urlsafe(48)}
    settings["PUBLIC_ORIGIN"] = args.origin.rstrip("/")
    if args.mail:
        sender = input("Verified Brevo sender email: ").strip()
        key = getpass.getpass("Brevo API key (hidden): ").strip()
        if not sender or not key:
            parser.error("Both sender and key are required")
        settings.update(SMTP_FROM=sender, BREVO_API_KEY=key)
    SETTINGS.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile("w", dir=SETTINGS.parent, delete=False) as dest:
        json.dump(settings, dest)
    os.replace(dest.name, SETTINGS)
    print("Private settings saved. Reload the website from the Web tab.")


if __name__ == "__main__":
    main()
