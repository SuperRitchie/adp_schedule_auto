#!/usr/bin/env python3
"""Build a small static website for subscribing to generated employee ICS feeds.

Input:  parsed_schedule/calendar_index.json and parsed_schedule/calendars/*.ics
Output: a static folder that can be committed to GitHub Pages.
"""

from __future__ import annotations

import argparse
import html
import json
import shutil
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path


def clean_base_url(value: str) -> str:
    value = (value or "").strip()
    if not value:
        raise SystemExit("--base-url is required, for example https://ritchiek.tech/adp-calendars")
    return value.rstrip("/")


def webcal_url(https_url: str) -> str:
    if https_url.startswith("https://"):
        return "webcal://" + https_url[len("https://") :]
    if https_url.startswith("http://"):
        return "webcal://" + https_url[len("http://") :]
    return https_url


def google_calendar_url(webcal_feed_url: str) -> str:
    """Return a Google Calendar subscription URL.

    Google Calendar's cid parameter should point at the webcal:// feed, not the
    https:// feed. Keeping it unescaped also matches the share format Google
    accepts in practice, e.g.
    https://calendar.google.com/calendar/u/0/r?cid=webcal://example.com/feed.ics
    """
    return "https://calendar.google.com/calendar/u/0/r?cid=" + webcal_feed_url


def outlook_calendar_url() -> str:
    """Return the Outlook web calendar page.

    Outlook does not provide a dependable public one-click subscribe URL for an
    arbitrary external ICS feed, so the site opens Outlook Calendar and shows
    the user the exact ICS URL to paste under Add calendar -> Subscribe from web.
    """
    return "https://outlook.office.com/calendar/addcalendar"


def generated_time_label() -> str:
    generated = datetime.now(ZoneInfo("America/Vancouver")).replace(microsecond=0)
    return generated.strftime("%Y-%m-%d %I:%M:%S %p %Z (Vancouver time)")


def esc(value: object) -> str:
    return html.escape(str(value or ""), quote=True)


def read_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")


def render_home_page(entries: list[dict], base_url: str, generated_at: str, parse_summary: dict) -> str:
    rows = []
    for item in entries:
        name = esc(item["employee_name"])
        slug = esc(item["employee_slug"])
        shift_count = esc(item.get("shift_count", 0))
        https_url = esc(item["https_url"])
        webcal = esc(item["webcal_url"])
        page_url = f"u/{slug}/"
        rows.append(
            f"""
            <tr data-name="{name.lower()}" data-slug="{slug}">
              <td><a href="{page_url}">{name}</a></td>
              <td><code>{slug}</code></td>
              <td>{shift_count}</td>
              <td><a href="{webcal}">Subscribe</a></td>
              <td><a href="{outlook_calendar_url()}" target="_blank" rel="noopener">Outlook</a></td>
              <td><a href="{https_url}">ICS</a></td>
            </tr>
            """
        )

    week_text = ""
    if parse_summary:
        parts = []
        for key in ("week_start", "week_end", "weeks", "total_shifts", "employee_count"):
            if key in parse_summary:
                parts.append(f"{esc(key)}: {esc(parse_summary[key])}")
        if parts:
            week_text = "<p class=\"muted\">" + " · ".join(parts) + "</p>"

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MEC Schedule Calendars</title>
  <style>
    :root {{ color-scheme: light dark; }}
    body {{ font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; line-height: 1.45; }}
    main {{ max-width: 1100px; margin: 0 auto; }}
    h1 {{ margin-bottom: 0.25rem; }}
    .muted {{ color: #666; }}
    input {{ width: 100%; max-width: 520px; padding: 0.75rem; font-size: 1rem; margin: 1rem 0; }}
    table {{ width: 100%; border-collapse: collapse; }}
    th, td {{ text-align: left; padding: 0.65rem; border-bottom: 1px solid #ddd; vertical-align: top; }}
    code {{ font-size: 0.9rem; }}
    .cards {{ display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin: 1rem 0; }}
    .card {{ border: 1px solid #ddd; border-radius: 0.75rem; padding: 1rem; }}
    a {{ color: #0969da; }}
  </style>
</head>
<body>
<main>
  <h1>MEC Schedule Calendars</h1>
  <p class="muted">Generated {esc(generated_at)}. Base URL: <code>{esc(base_url)}</code></p>
  {week_text}

  <div class="cards">
    <div class="card"><strong>iPhone / Apple Calendar</strong><br>Open an employee page and tap <em>Subscribe</em>.</div>
    <div class="card"><strong>Google Calendar</strong><br>Open an employee page and tap <em>Add to Google Calendar</em>.</div>
    <div class="card"><strong>Outlook Calendar</strong><br>Open an employee page, tap <em>Add to Outlook Calendar</em>, then paste the HTTPS ICS URL under <em>Add calendar → Subscribe from web</em>.</div>
    <div class="card"><strong>Direct feeds</strong><br>Each employee has a stable <code>.ics</code> URL that gets replaced when the workflow runs.</div>
  </div>

  <label for="search"><strong>Search employee calendars</strong></label><br>
  <input id="search" type="search" placeholder="Type a name or slug..." autocomplete="off">

  <table id="calendar-table">
    <thead>
      <tr><th>Name</th><th>Slug</th><th>Shifts</th><th>Subscribe</th><th>Outlook</th><th>ICS URL</th></tr>
    </thead>
    <tbody>
      {''.join(rows)}
    </tbody>
  </table>
</main>
<script>
const input = document.getElementById('search');
const rows = Array.from(document.querySelectorAll('#calendar-table tbody tr'));
input.addEventListener('input', () => {{
  const q = input.value.trim().toLowerCase();
  rows.forEach(row => {{
    row.style.display = !q || row.dataset.name.includes(q) || row.dataset.slug.includes(q) ? '' : 'none';
  }});
}});
</script>
</body>
</html>
"""


def render_employee_page(item: dict, generated_at: str) -> str:
    name = esc(item["employee_name"])
    slug = esc(item["employee_slug"])
    https_url = esc(item["https_url"])
    webcal = esc(item["webcal_url"])
    google_add = google_calendar_url(item["webcal_url"])
    outlook_add = outlook_calendar_url()
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{name} schedule calendar</title>
  <style>
    :root {{ color-scheme: light dark; }}
    body {{ font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; line-height: 1.5; }}
    main {{ max-width: 760px; margin: 0 auto; }}
    .button {{ display: inline-block; margin: 0.35rem 0.35rem 0.35rem 0; padding: 0.75rem 1rem; border-radius: 0.6rem; background: #0969da; color: white; text-decoration: none; border: 0; font: inherit; cursor: pointer; }}
    .button.secondary {{ background: #57606a; }}
    code {{ overflow-wrap: anywhere; }}
    .muted {{ color: #666; }}
    .steps {{ padding-left: 1.25rem; }}
  </style>
</head>
<body>
<main>
  <p><a href="../../">← All calendars</a></p>
  <h1>{name}</h1>
  <p class="muted">Calendar slug: <code>{slug}</code>. Generated {esc(generated_at)}.</p>

  <p>
    <a class="button" href="{webcal}">Subscribe with Apple Calendar</a>
    <a class="button" href="{esc(google_add)}">Add to Google Calendar</a>
    <a class="button" href="{esc(outlook_add)}" target="_blank" rel="noopener">Add to Outlook Calendar</a>
    <button class="button secondary" type="button" onclick="copyIcsUrl()">Copy ICS URL</button>
    <a class="button secondary" href="{https_url}">Download ICS</a>
  </p>

  <h2>Subscription URL</h2>
  <p>Use this HTTPS URL in Google Calendar, Outlook, or any calendar app that asks for a calendar URL:</p>
  <p><code id="ics-url">{https_url}</code></p>

  <h2>Outlook Calendar</h2>
  <ol class="steps">
    <li>Tap <strong>Copy ICS URL</strong>.</li>
    <li>Tap <strong>Add to Outlook Calendar</strong>.</li>
    <li>In Outlook, choose <strong>Add calendar → Subscribe from web</strong>, paste the URL, then save.</li>
  </ol>

  <h2>Apple Calendar / iPhone URL</h2>
  <p><code>{webcal}</code></p>
</main>
<script>
async function copyIcsUrl() {{
  const value = document.getElementById('ics-url').textContent.trim();
  try {{
    await navigator.clipboard.writeText(value);
    alert('Copied ICS URL. In Outlook, use Add calendar → Subscribe from web.');
  }} catch (error) {{
    window.prompt('Copy this ICS URL:', value);
  }}
}}
</script>
</body>
</html>
"""


def build_site(source_dir: Path, out_dir: Path, base_url: str) -> None:
    base_url = clean_base_url(base_url)
    source_dir = source_dir.resolve()
    out_dir = out_dir.resolve()
    index_path = source_dir / "calendar_index.json"
    calendars_dir = source_dir / "calendars"
    if not index_path.exists():
        raise SystemExit(f"Missing calendar index: {index_path}")
    if not calendars_dir.exists():
        raise SystemExit(f"Missing calendars directory: {calendars_dir}")

    raw_entries = read_json(index_path, [])
    parse_summary = read_json(source_dir / "parse_summary.json", {})
    generated_at = generated_time_label()

    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    entries: list[dict] = []
    for raw in raw_entries:
        rel = Path(raw.get("ics_file", ""))
        if not rel.name.endswith(".ics"):
            continue
        src = source_dir / rel
        if not src.exists():
            continue
        dest_rel = Path("calendars") / rel.name
        dest = out_dir / dest_rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        item = dict(raw)
        item["ics_file"] = dest_rel.as_posix()
        item["https_url"] = f"{base_url}/{dest_rel.as_posix()}"
        item["webcal_url"] = webcal_url(item["https_url"])
        item["employee_page"] = f"{base_url}/u/{item['employee_slug']}/"
        entries.append(item)

    entries.sort(key=lambda item: str(item.get("employee_name", "")).lower())

    write_text(out_dir / "index.html", render_home_page(entries, base_url, generated_at, parse_summary))
    write_text(out_dir / "calendar_index.json", json.dumps(entries, indent=2, ensure_ascii=False) + "\n")
    write_text(out_dir / ".nojekyll", "")
    write_text(out_dir / "robots.txt", "User-agent: *\nDisallow: /\n")
    write_text(
        out_dir / "README.txt",
        f"MEC subscribable calendar feeds\nGenerated: {generated_at}\nBase URL: {base_url}\nCalendar count: {len(entries)}\n",
    )

    for item in entries:
        page_dir = out_dir / "u" / item["employee_slug"]
        write_text(page_dir / "index.html", render_employee_page(item, generated_at))

    print(f"Built calendar site with {len(entries)} calendars at {out_dir}")
    print(f"Index URL will be: {base_url}/")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a static subscribable calendar site from parsed ADP schedule outputs.")
    parser.add_argument("--source-dir", default="parsed_schedule", help="Directory containing calendar_index.json and calendars/*.ics")
    parser.add_argument("--out-dir", default="calendar_site", help="Static output directory to publish to GitHub Pages")
    parser.add_argument("--base-url", default="https://ritchiek.tech/adp-calendars", help="Public base URL where out-dir will be hosted")
    args = parser.parse_args()
    build_site(Path(args.source_dir), Path(args.out_dir), args.base_url)


if __name__ == "__main__":
    main()
