#!/usr/bin/env python3
"""
Upload generated ADP/UKG schedule outputs to a Google Drive folder.

Expected use in GitHub Actions:
  python3 scripts/upload_to_drive.py \
    --source-dir parsed_schedule \
    --folder-id "$GOOGLE_DRIVE_FOLDER_ID" \
    --service-account-file .secrets/google-service-account.json

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

from google.oauth2 import service_account
from googleapiclient.discovery import build
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
        "--service-account-file",
        type=Path,
        help=(
            "Service account JSON file. Optional when "
            "GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_B64 is set."
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


def escape_drive_query_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


def build_drive_service(service_account_file: Path | None):
    encoded_credentials = os.environ.get("GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_B64", "")
    if encoded_credentials:
        try:
            decoded = base64.b64decode("".join(encoded_credentials.split()), validate=True)
            service_account_info = json.loads(decoded.decode("utf-8"))
        except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SystemExit(
                "GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_B64 is set but could not be decoded "
                "as a base64-encoded service account JSON document."
            ) from exc

        credentials = service_account.Credentials.from_service_account_info(
            service_account_info,
            scopes=SCOPES,
        )
        print("Loaded Google service account credentials from GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_B64.")
        return build("drive", "v3", credentials=credentials, cache_discovery=False)

    if service_account_file is None:
        raise SystemExit(
            "Provide --service-account-file or set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_B64."
        )

    credentials = service_account.Credentials.from_service_account_file(
        service_account_file,
        scopes=SCOPES,
    )
    print(f"Loaded Google service account credentials from {service_account_file}.")
    return build("drive", "v3", credentials=credentials, cache_discovery=False)


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

    service = build_drive_service(args.service_account_file)
    uploaded: list[UploadedFile] = []

    for local_path in iter_files(source_dir, allowed_extensions):
        uploaded_file = upload_or_update_file(
            service,
            local_path=local_path,
            source_dir=source_dir,
            root_folder_id=args.folder_id,
        )
        uploaded.append(uploaded_file)
        print(f"{uploaded_file.action.upper():7} {uploaded_file.drive_path} -> {uploaded_file.file_id}")

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
