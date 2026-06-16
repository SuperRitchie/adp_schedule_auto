#!/usr/bin/env python3
"""
Upload generated ADP/UKG schedule outputs to a Google Drive folder.

Recommended GitHub Actions auth mode:
  Use user OAuth secrets so uploaded files are owned by your Google account:
    GOOGLE_DRIVE_CREDENTIALS_JSON_B64
    GOOGLE_DRIVE_TOKEN_JSON_B64

Service account mode is still supported, but Google Drive service accounts do
not have personal storage quota. Service accounts can upload to Shared Drives,
but they will fail when uploading into a normal My Drive folder.

The script preserves the local folder structure. For example:
  parsed_schedule/shifts.csv              -> <Drive folder>/shifts.csv
  parsed_schedule/calendars/name.ics      -> <Drive folder>/calendars/name.ics

Existing Drive files with the same name in the same folder are updated in place,
so shared Drive URLs usually stay stable.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import mimetypes
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

from google.auth.transport.requests import Request
from google.oauth2 import service_account
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload

SCOPES = ["https://www.googleapis.com/auth/drive"]
FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"


@dataclass
class UploadedFile:
    local_path: str
    drive_path: str
    file_id: str
    action: str
    mime_type: str
    web_view_link: str | None = None
    web_content_link: str | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upload parsed schedule files to Google Drive.")
    parser.add_argument("--source-dir", default="parsed_schedule", type=Path, help="Local folder to upload.")
    parser.add_argument("--folder-id", required=True, help="Destination Google Drive folder ID.")
    parser.add_argument(
        "--oauth-client-file",
        type=Path,
        help=(
            "OAuth desktop/web client JSON file. Optional when "
            "GOOGLE_DRIVE_CREDENTIALS_JSON_B64 is set."
        ),
    )
    parser.add_argument(
        "--oauth-token-file",
        type=Path,
        help=(
            "OAuth token JSON file. Optional when GOOGLE_DRIVE_TOKEN_JSON_B64 is set. "
            "This is the preferred auth mode for normal My Drive folders."
        ),
    )
    parser.add_argument(
        "--service-account-file",
        type=Path,
        help=(
            "Service account JSON file. Optional when "
            "GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_B64 is set. Use this only for Shared Drives."
        ),
    )
    parser.add_argument(
        "--include",
        default=".ics,.csv,.json",
        help="Comma-separated file extensions to upload. Default: .ics,.csv,.json",
    )
    parser.add_argument(
        "--manifest-name",
        default="drive_upload_manifest.json",
        help="Manifest filename written locally after upload. Use empty string to disable.",
    )
    return parser.parse_args()


def read_b64_json_env(name: str) -> dict | None:
    encoded = os.environ.get(name, "")
    if not encoded:
        return None
    try:
        decoded = base64.b64decode("".join(encoded.split()), validate=True)
        return json.loads(decoded.decode("utf-8"))
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SystemExit(
            f"{name} is set but could not be decoded as a base64-encoded JSON document."
        ) from exc


def read_json_file(path: Path | None) -> dict | None:
    if path is None:
        return None
    if not path.exists():
        raise SystemExit(f"JSON file does not exist: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def load_oauth_credentials(oauth_client_file: Path | None, oauth_token_file: Path | None):
    # Prefer Drive-specific OAuth secrets. Fall back to the older generic Google
    # OAuth secret names only if they contain Drive scopes.
    token_info = read_b64_json_env("GOOGLE_DRIVE_TOKEN_JSON_B64")
    client_info = read_b64_json_env("GOOGLE_DRIVE_CREDENTIALS_JSON_B64")
    source = "GOOGLE_DRIVE_*_JSON_B64"

    if token_info is None or client_info is None:
        token_info = token_info or read_json_file(oauth_token_file)
        client_info = client_info or read_json_file(oauth_client_file)
        source = "OAuth JSON files"

    if token_info is None or client_info is None:
        generic_token_info = read_b64_json_env("GOOGLE_TOKEN_JSON_B64")
        generic_client_info = read_b64_json_env("GOOGLE_CREDENTIALS_JSON_B64")
        if generic_token_info and generic_client_info:
            token_info = generic_token_info
            client_info = generic_client_info
            source = "GOOGLE_*_JSON_B64 fallback"

    if token_info is None or client_info is None:
        return None

    creds = Credentials.from_authorized_user_info(token_info, SCOPES)
    if not creds.valid:
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            print("Refreshed Google Drive OAuth access token.")
        else:
            raise SystemExit(
                "Google Drive OAuth token is not valid and cannot be refreshed. "
                "Regenerate GOOGLE_DRIVE_TOKEN_JSON_B64 with scripts/auth_google_drive_oauth.py."
            )

    print(f"Loaded Google Drive OAuth user credentials from {source}.")
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def load_service_account_credentials(service_account_file: Path | None):
    service_account_info = read_b64_json_env("GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_B64")
    source = "GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_B64"

    if service_account_info is None:
        service_account_info = read_json_file(service_account_file)
        source = str(service_account_file) if service_account_file else ""

    if service_account_info is None:
        return None

    credentials = service_account.Credentials.from_service_account_info(
        service_account_info,
        scopes=SCOPES,
    )
    print(f"Loaded Google service account credentials from {source}.")
    print(
        "Note: service accounts do not have My Drive storage quota. "
        "Use a Shared Drive folder, or use GOOGLE_DRIVE_TOKEN_JSON_B64 OAuth instead."
    )
    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def build_drive_service(oauth_client_file: Path | None, oauth_token_file: Path | None, service_account_file: Path | None):
    oauth_service = load_oauth_credentials(oauth_client_file, oauth_token_file)
    if oauth_service is not None:
        return oauth_service

    service_account_service = load_service_account_credentials(service_account_file)
    if service_account_service is not None:
        return service_account_service

    raise SystemExit(
        "No Google Drive credentials found. Recommended: set GOOGLE_DRIVE_CREDENTIALS_JSON_B64 "
        "and GOOGLE_DRIVE_TOKEN_JSON_B64. For Shared Drives only, you may set "
        "GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_B64."
    )


def escape_drive_query_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


def find_child(service, parent_id: str, name: str, mime_type: str | None = None) -> dict | None:
    safe_name = escape_drive_query_string(name)
    query = f"name = '{safe_name}' and '{parent_id}' in parents and trashed = false"
    if mime_type:
        query += f" and mimeType = '{escape_drive_query_string(mime_type)}'"

    response = service.files().list(
        q=query,
        spaces="drive",
        fields="files(id,name,mimeType,webViewLink,webContentLink)",
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
        pageSize=10,
    ).execute()
    files = response.get("files", [])
    return files[0] if files else None


def ensure_drive_folder(service, parent_id: str, folder_name: str) -> str:
    existing = find_child(service, parent_id, folder_name, FOLDER_MIME_TYPE)
    if existing:
        return existing["id"]

    created = service.files().create(
        body={
            "name": folder_name,
            "mimeType": FOLDER_MIME_TYPE,
            "parents": [parent_id],
        },
        fields="id,name,webViewLink",
        supportsAllDrives=True,
    ).execute()
    return created["id"]


def guess_mime_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".ics":
        return "text/calendar"
    if suffix == ".csv":
        return "text/csv"
    if suffix == ".json":
        return "application/json"
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def iter_files(source_dir: Path, allowed_extensions: set[str]) -> Iterable[Path]:
    for path in sorted(source_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.name.startswith("."):
            continue
        if path.suffix.lower() not in allowed_extensions:
            continue
        yield path


def ensure_parent_folder_path(service, root_folder_id: str, relative_parent: Path) -> str:
    current_id = root_folder_id
    for part in relative_parent.parts:
        if not part or part == ".":
            continue
        current_id = ensure_drive_folder(service, current_id, part)
    return current_id


def explain_quota_error(exc: HttpError) -> None:
    text = str(exc)
    if "Service Accounts do not have storage quota" not in text and "storageQuotaExceeded" not in text:
        return

    print("\nGoogle Drive upload failed because the active credentials are a service account.")
    print("Service accounts cannot own files in a normal personal My Drive folder.")
    print("Fix one of these ways:")
    print("  1. Recommended for personal Drive: use OAuth secrets GOOGLE_DRIVE_CREDENTIALS_JSON_B64 and GOOGLE_DRIVE_TOKEN_JSON_B64.")
    print("  2. Workspace option: upload into a real Google Shared Drive folder, not a normal shared My Drive folder.")
    print("\nTo generate OAuth token secrets locally:")
    print("  python3 scripts/auth_google_drive_oauth.py --credentials .secrets/google_drive_credentials.json --token .secrets/google_drive_token.json")


def upload_or_update_file(service, *, local_path: Path, source_dir: Path, root_folder_id: str) -> UploadedFile:
    relative_path = local_path.relative_to(source_dir)
    parent_id = ensure_parent_folder_path(service, root_folder_id, relative_path.parent)
    mime_type = guess_mime_type(local_path)
    existing = find_child(service, parent_id, local_path.name)
    media = MediaFileUpload(str(local_path), mimetype=mime_type, resumable=True)

    if existing:
        result = service.files().update(
            fileId=existing["id"],
            body={"name": local_path.name},
            media_body=media,
            fields="id,name,webViewLink,webContentLink",
            supportsAllDrives=True,
        ).execute()
        action = "updated"
    else:
        result = service.files().create(
            body={"name": local_path.name, "parents": [parent_id]},
            media_body=media,
            fields="id,name,webViewLink,webContentLink",
            supportsAllDrives=True,
        ).execute()
        action = "created"

    return UploadedFile(
        local_path=str(local_path),
        drive_path=str(relative_path),
        file_id=result["id"],
        action=action,
        mime_type=mime_type,
        web_view_link=result.get("webViewLink"),
        web_content_link=result.get("webContentLink"),
    )


def main() -> None:
    args = parse_args()
    source_dir = args.source_dir.resolve()
    if not source_dir.exists():
        raise SystemExit(f"Source directory does not exist: {source_dir}")

    allowed_extensions = {
        ext.strip().lower() if ext.strip().startswith(".") else f".{ext.strip().lower()}"
        for ext in args.include.split(",")
        if ext.strip()
    }

    service = build_drive_service(
        oauth_client_file=args.oauth_client_file,
        oauth_token_file=args.oauth_token_file,
        service_account_file=args.service_account_file,
    )
    uploaded: list[UploadedFile] = []

    try:
        for local_path in iter_files(source_dir, allowed_extensions):
            uploaded_file = upload_or_update_file(
                service,
                local_path=local_path,
                source_dir=source_dir,
                root_folder_id=args.folder_id,
            )
            uploaded.append(uploaded_file)
            print(f"{uploaded_file.action.upper():7} {uploaded_file.drive_path} -> {uploaded_file.file_id}")
    except HttpError as exc:
        explain_quota_error(exc)
        raise

    manifest = {
        "source_dir": str(source_dir),
        "drive_folder_id": args.folder_id,
        "uploaded_count": len(uploaded),
        "files": [asdict(item) for item in uploaded],
    }

    if args.manifest_name:
        manifest_path = source_dir / args.manifest_name
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print(f"Wrote local upload manifest: {manifest_path}")

    print(f"Uploaded or updated {len(uploaded)} files.")


if __name__ == "__main__":
    main()
