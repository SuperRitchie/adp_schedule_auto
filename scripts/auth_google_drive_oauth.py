#!/usr/bin/env python3
"""
Create a Google Drive OAuth token for GitHub Actions uploads.

Usage:
  python3 scripts/auth_google_drive_oauth.py \
    --credentials .secrets/google_drive_credentials.json \
    --token .secrets/google_drive_token.json

Then base64 the token JSON into GOOGLE_DRIVE_TOKEN_JSON_B64.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/drive"]


def parse_args():
    parser = argparse.ArgumentParser(description="Generate Google Drive OAuth token JSON.")
    parser.add_argument("--credentials", required=True, type=Path, help="OAuth client JSON from Google Cloud.")
    parser.add_argument("--token", default=Path(".secrets/google_drive_token.json"), type=Path, help="Output token JSON path.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.credentials.exists():
        raise SystemExit(f"OAuth credentials file not found: {args.credentials}")

    flow = InstalledAppFlow.from_client_secrets_file(str(args.credentials), SCOPES)
    creds = flow.run_local_server(port=0)

    args.token.parent.mkdir(parents=True, exist_ok=True)
    args.token.write_text(creds.to_json(), encoding="utf-8")
    print(f"Wrote Google Drive OAuth token to {args.token}")
    print("Base64 it with:")
    print(f"base64 -i {args.token} | tr -d '\\n' | pbcopy")


if __name__ == "__main__":
    main()
