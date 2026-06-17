#!/usr/bin/env python3
"""
Parse an exported UKG/ADP Team Schedule HTML page into clean shift data.

Usage:
    python team_schedule_parser.py "Team Schedule.html" --out-dir parsed_schedule
    python team_schedule_parser.py week1.html week2.html --out-dir parsed_schedule

Outputs:
    shifts.csv          flat table: one row per employee shift
    shifts.json         flat JSON list: one object per employee shift
    employees.json      nested JSON grouped by employee
    calendars/*.ics     one calendar file per employee
    calendar_index.json list of generated employee calendar filenames
    parse_summary.json  counts and warnings
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import unicodedata
from dataclasses import asdict, dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Iterable

from bs4 import BeautifulSoup, Tag

DATE_RANGE_RE = re.compile(
    r"(?P<sm>\d{1,2})/(?P<sd>\d{1,2})/(?P<sy>\d{4})\s*-\s*"
    r"(?P<em>\d{1,2})/(?P<ed>\d{1,2})/(?P<ey>\d{4})"
)
SHIFT_RE = re.compile(
    r"(?P<start>\d{1,2}:\d{2}\s*[AP]M)\s*-\s*"
    r"(?P<end>\d{1,2}:\d{2}\s*[AP]M)"
    r"(?:\s*\[(?P<hours>\d+(?:\.\d+)?)\])?",
    re.IGNORECASE,
)
DAY_COL_RE = re.compile(r"^day-(\d)$")


@dataclass(frozen=True)
class ShiftRecord:
    source_file: str
    employee_name: str
    employee_slug: str
    employee_id: str
    primary_job: str
    primary_job_path: str
    date: str
    day_col: str
    start_time: str
    end_time: str
    start_datetime: str
    end_datetime: str
    hours: float | None
    raw_shift_text: str
    shift_id: str
    is_transfer: bool


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", value).strip()


def slugify_name(name: str) -> str:
    """Create a readable filename-safe name slug, e.g. 'Kumar, Ritchie' -> 'kumar-ritchie'."""
    normalized = unicodedata.normalize("NFKD", name)
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii")
    ascii_text = ascii_text.lower()
    ascii_text = ascii_text.replace("'", "")
    ascii_text = re.sub(r"[^a-z0-9]+", "-", ascii_text).strip("-")
    return ascii_text or "unknown-employee"


def parse_employee_id(name_cell: Tag | None) -> str:
    if not name_cell:
        return ""
    employee_div = name_cell.select_one("[automation-id^='location_schedule_employee_cell_']")
    if not employee_div:
        return ""
    automation_id = employee_div.get("automation-id", "")
    return automation_id.replace("location_schedule_employee_cell_", "")


def parse_date_range(soup: BeautifulSoup) -> tuple[date, date]:
    """Find the week start/end from the toolbar, e.g. '6/07/2026 - 6/13/2026'."""
    text = clean_text(soup.get_text(" ", strip=True))
    match = DATE_RANGE_RE.search(text)
    if not match:
        raise ValueError("Could not find schedule date range like '6/07/2026 - 6/13/2026'.")

    start = date(
        int(match.group("sy")),
        int(match.group("sm")),
        int(match.group("sd")),
    )
    end = date(
        int(match.group("ey")),
        int(match.group("em")),
        int(match.group("ed")),
    )
    return start, end


def parse_time_value(value: str) -> time:
    return datetime.strptime(value.upper().replace(" ", ""), "%I:%M%p").time()


def combine_date_time(shift_date: date, start_text: str, end_text: str) -> tuple[datetime, datetime]:
    start_dt = datetime.combine(shift_date, parse_time_value(start_text))
    end_dt = datetime.combine(shift_date, parse_time_value(end_text))
    if end_dt <= start_dt:
        end_dt += timedelta(days=1)
    return start_dt, end_dt


def get_primary_job(row: Tag) -> tuple[str, str]:
    primary_job_cell = row.select_one('[col-id="primaryJob"]')
    if not primary_job_cell:
        return "", ""

    visible = clean_text(primary_job_cell.select_one("span").get_text(" ", strip=True)) if primary_job_cell.select_one("span") else ""
    tooltip = primary_job_cell.select_one("krn-ngx-tooltip")
    path = clean_text(tooltip.get_text(" ", strip=True).replace("<!---->", "")) if tooltip else ""
    return visible or clean_text(primary_job_cell.get_text(" ", strip=True)), path


def parse_shift_entities(
    *,
    source_file: str,
    employee_name: str,
    employee_id: str,
    primary_job: str,
    primary_job_path: str,
    day_col: str,
    shift_date: date,
    cell: Tag,
) -> list[ShiftRecord]:
    records: list[ShiftRecord] = []
    employee_slug = slugify_name(employee_name)

    # Prefer explicit entity wrappers, because a cell could theoretically contain multiple shifts.
    entities = cell.select(".location-schedule-cell__entity")
    if not entities:
        return records

    for index, entity in enumerate(entities):
        title_el = entity.select_one(".location-schedule-cell__title")
        raw = clean_text(title_el.get_text(" ", strip=True)) if title_el else clean_text(entity.get_text(" ", strip=True))
        match = SHIFT_RE.search(raw)
        if not match:
            # Skip non-shift items for now. The summary will still show counts/warnings.
            continue

        start_text = clean_text(match.group("start"))
        end_text = clean_text(match.group("end"))
        hours_text = match.group("hours")
        hours = float(hours_text) if hours_text is not None else None
        start_dt, end_dt = combine_date_time(shift_date, start_text, end_text)

        automation_id = entity.get("automation-id", "")
        shift_id = automation_id.replace("location_schedule_cell_shift_", "") if automation_id else f"{day_col}-{index}"
        shift_box = entity.select_one(".location-schedule-cell__shift")
        shift_classes = shift_box.get("class", []) if shift_box else []
        is_transfer = "location-schedule-cell__transfer-bar" in shift_classes or entity.select_one(".icon-k-transfer") is not None

        records.append(
            ShiftRecord(
                source_file=source_file,
                employee_name=employee_name,
                employee_slug=employee_slug,
                employee_id=employee_id,
                primary_job=primary_job,
                primary_job_path=primary_job_path,
                date=shift_date.isoformat(),
                day_col=day_col,
                start_time=start_text.upper(),
                end_time=end_text.upper(),
                start_datetime=start_dt.isoformat(timespec="minutes"),
                end_datetime=end_dt.isoformat(timespec="minutes"),
                hours=hours,
                raw_shift_text=raw,
                shift_id=shift_id,
                is_transfer=is_transfer,
            )
        )

    return records


def iter_schedule_rows(soup: BeautifulSoup) -> Iterable[Tag]:
    """
    Return only the useful rendered grid rows.

    UKG/ADP's grid uses hidden pinned containers and virtualized rows. The center container
    has the actual rendered team rows. The floating top container usually has 'My Schedule'.
    """
    for selector in (".ag-floating-top-container", ".ag-center-cols-container"):
        # Use select() rather than select_one(). The Playwright capturer may
        # append an extra synthetic .ag-center-cols-container containing rows
        # collected across every scroll position in the virtualized grid.
        for container in soup.select(selector):
            for row in container.select(':scope > div[role="row"]'):
                yield row


def parse_team_schedule_html(path: Path) -> tuple[list[ShiftRecord], dict]:
    html = path.read_text(encoding="utf-8", errors="ignore")
    soup = BeautifulSoup(html, "html.parser")
    start_date, end_date = parse_date_range(soup)

    # Header usually displays the intended total, e.g. Name [122]. Saved HTML may include fewer
    # rendered rows because the web app virtualizes rows while scrolling.
    expected_employee_count = None
    name_header = soup.select_one('.ag-header-cell[col-id="name"]')
    if name_header:
        match = re.search(r"\[(\d+)\]", clean_text(name_header.get_text(" ", strip=True)))
        if match:
            expected_employee_count = int(match.group(1))

    records: list[ShiftRecord] = []
    rendered_employee_names: list[str] = []
    skipped_non_shift_entities = 0

    for row in iter_schedule_rows(soup):
        name_cell = row.select_one('[col-id="name"]')
        name_el = name_cell.select_one(".location-schedule-employee-cell__name") if name_cell else None
        employee_name = clean_text(name_el.get_text(" ", strip=True)) if name_el else ""
        if not employee_name:
            continue

        rendered_employee_names.append(employee_name)
        employee_id = parse_employee_id(name_cell)
        primary_job, primary_job_path = get_primary_job(row)

        for day_index in range(7):
            day_col = f"day-{day_index}"
            cell = row.select_one(f'[col-id="{day_col}"]')
            if not cell:
                continue

            entities = cell.select(".location-schedule-cell__entity")
            parsed = parse_shift_entities(
                source_file=path.name,
                employee_name=employee_name,
                employee_id=employee_id,
                primary_job=primary_job,
                primary_job_path=primary_job_path,
                day_col=day_col,
                shift_date=start_date + timedelta(days=day_index),
                cell=cell,
            )
            records.extend(parsed)

            if entities and len(parsed) < len(entities):
                skipped_non_shift_entities += len(entities) - len(parsed)

    unique_rendered_employees = sorted(set(rendered_employee_names), key=str.lower)
    summary = {
        "source_file": path.name,
        "week_start": start_date.isoformat(),
        "week_end": end_date.isoformat(),
        "expected_employee_count_from_header": expected_employee_count,
        "rendered_employee_count_in_saved_html": len(unique_rendered_employees),
        "shift_count": len(records),
        "skipped_non_shift_entities": skipped_non_shift_entities,
        "warning": None,
    }
    if expected_employee_count and len(unique_rendered_employees) < expected_employee_count:
        summary["warning"] = (
            f"Header says {expected_employee_count} employees, but this saved HTML contains "
            f"only {len(unique_rendered_employees)} rendered employees. The schedule grid is probably virtualized; "
            "to capture everyone, scroll through the full grid before saving or use the app's export/print view if available."
        )

    return records, summary


def dedupe_records(records: list[ShiftRecord]) -> list[ShiftRecord]:
    seen: set[tuple] = set()
    deduped: list[ShiftRecord] = []
    for rec in records:
        key = (
            rec.employee_name,
            rec.date,
            rec.start_time,
            rec.end_time,
            rec.shift_id,
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(rec)
    return deduped


def group_by_employee(records: list[ShiftRecord]) -> list[dict]:
    grouped: dict[str, dict] = {}
    for rec in records:
        group = grouped.setdefault(
            rec.employee_slug,
            {
                "employee_name": rec.employee_name,
                "employee_slug": rec.employee_slug,
                "employee_id": rec.employee_id,
                "primary_job": rec.primary_job,
                "primary_job_path": rec.primary_job_path,
                "shifts": [],
            },
        )
        group["shifts"].append(asdict(rec))

    employees = list(grouped.values())
    employees.sort(key=lambda item: item["employee_name"].lower())
    for employee in employees:
        employee["shifts"].sort(key=lambda rec: (rec["start_datetime"], rec["end_datetime"], rec["shift_id"]))
    return employees



def ics_escape(value: str) -> str:
    return (
        value.replace('\\', '\\\\')
        .replace(';', '\\;')
        .replace(',', '\\,')
        .replace('\n', '\\n')
    )


def ics_datetime(local_iso: str) -> str:
    return datetime.fromisoformat(local_iso).strftime('%Y%m%dT%H%M%S')


def parse_alarm_minutes(value: str) -> list[int]:
    minutes: list[int] = []
    for part in (value or '').split(','):
        part = part.strip()
        if not part:
            continue
        try:
            amount = int(part)
        except ValueError:
            continue
        if amount > 0:
            minutes.append(amount)
    return sorted(set(minutes), reverse=True)


def alarm_trigger(minutes: int) -> str:
    if minutes % 1440 == 0:
        return f'-P{minutes // 1440}D'
    hours, mins = divmod(minutes, 60)
    if hours and mins:
        return f'-PT{hours}H{mins}M'
    if hours:
        return f'-PT{hours}H'
    return f'-PT{mins}M'


def ics_refresh_minutes(value: str) -> int:
    try:
        minutes = int(str(value or '').strip())
    except ValueError:
        minutes = 60
    return max(5, minutes)


def ics_refresh_duration(minutes: int) -> str:
    minutes = max(5, minutes)
    if minutes % 1440 == 0:
        return f'P{minutes // 1440}D'
    hours, mins = divmod(minutes, 60)
    if hours and mins:
        return f'PT{hours}H{mins}M'
    if hours:
        return f'PT{hours}H'
    return f'PT{mins}M'


def build_employee_ics(employee: dict, *, tzid: str, location: str, alarm_minutes: list[int], refresh_minutes: int = 60) -> str:
    generated_at = datetime.now(timezone.utc)
    now = generated_at.strftime('%Y%m%dT%H%M%SZ')
    sequence = int(generated_at.timestamp())
    refresh_duration = ics_refresh_duration(refresh_minutes)
    name = employee['employee_name']
    lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Ritchie Kumar//ADP Schedule Parser//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        f'X-WR-CALNAME:{ics_escape(name)} Schedule',
        f'NAME:{ics_escape(name)} Schedule',
        f'X-WR-RELCALID:{ics_escape(employee["employee_slug"])}@ritchiek-tech-adp-calendars',
        f'X-WR-TIMEZONE:{ics_escape(tzid)}',
        f'REFRESH-INTERVAL;VALUE=DURATION:{refresh_duration}',
        f'X-PUBLISHED-TTL:{refresh_duration}',
    ]

    for shift in employee['shifts']:
        uid_key = f"{shift.get('employee_slug')}:{shift.get('date')}:{shift.get('start_time')}:{shift.get('end_time')}:{shift.get('shift_id')}"
        summary = 'Work Shift'
        description_parts = [
            f"Employee: {shift.get('employee_name', '')}",
            f"Job: {shift.get('primary_job', '')}",
            f"Source: {shift.get('source_file', '')}",
            f"Raw: {shift.get('raw_shift_text', '')}",
        ]
        if shift.get('is_transfer'):
            description_parts.append('Transfer: yes')

        lines.extend([
            'BEGIN:VEVENT',
            f'UID:{ics_escape(uid_key)}@adp-schedule-parser',
            f'DTSTAMP:{now}',
            f'LAST-MODIFIED:{now}',
            f'SEQUENCE:{sequence}',
            f'DTSTART;TZID={ics_escape(tzid)}:{ics_datetime(shift["start_datetime"])}',
            f'DTEND;TZID={ics_escape(tzid)}:{ics_datetime(shift["end_datetime"])}',
            f'SUMMARY:{ics_escape(summary)}',
            f'DESCRIPTION:{ics_escape(chr(10).join(description_parts))}',
        ])
        if location:
            lines.append(f'LOCATION:{ics_escape(location)}')
        for minutes in alarm_minutes:
            lines.extend([
                'BEGIN:VALARM',
                'ACTION:DISPLAY',
                f'TRIGGER:{alarm_trigger(minutes)}',
                'DESCRIPTION:Work shift reminder',
                'END:VALARM',
            ])
        lines.append('END:VEVENT')

    lines.append('END:VCALENDAR')
    return '\r\n'.join(lines) + '\r\n'


def write_employee_calendars(employees: list[dict], out_dir: Path, *, tzid: str, location: str, alarm_minutes: list[int], refresh_minutes: int = 60) -> list[dict]:
    calendar_dir = out_dir / 'calendars'
    calendar_dir.mkdir(parents=True, exist_ok=True)
    index: list[dict] = []
    for employee in employees:
        filename = f"{employee['employee_slug']}.ics"
        rel_path = f"calendars/{filename}"
        (calendar_dir / filename).write_text(
            build_employee_ics(employee, tzid=tzid, location=location, alarm_minutes=alarm_minutes, refresh_minutes=refresh_minutes),
            encoding='utf-8',
        )
        index.append({
            'employee_name': employee['employee_name'],
            'employee_slug': employee['employee_slug'],
            'employee_id': employee.get('employee_id', ''),
            'shift_count': len(employee.get('shifts', [])),
            'ics_file': rel_path,
        })
    return index


def write_outputs(records: list[ShiftRecord], summaries: list[dict], out_dir: Path, *, tzid: str, location: str, alarm_minutes: list[int], refresh_minutes: int = 60) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    records_as_dicts = [asdict(rec) for rec in records]

    csv_path = out_dir / "shifts.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(records_as_dicts[0].keys()) if records_as_dicts else ["employee_name"])
        writer.writeheader()
        writer.writerows(records_as_dicts)

    (out_dir / "shifts.json").write_text(
        json.dumps(records_as_dicts, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    employees = group_by_employee(records)
    (out_dir / "employees.json").write_text(
        json.dumps(employees, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    calendar_index = write_employee_calendars(employees, out_dir, tzid=tzid, location=location, alarm_minutes=alarm_minutes, refresh_minutes=refresh_minutes)
    (out_dir / "calendar_index.json").write_text(
        json.dumps(calendar_index, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    combined_summary = {
        "input_files": summaries,
        "total_shift_count": len(records),
        "total_employee_count_with_shifts": len({rec.employee_slug for rec in records}),
        "calendar_time_zone": tzid,
        "calendar_location": location,
        "calendar_alarm_minutes_before_shift": alarm_minutes,
        "calendar_refresh_minutes": refresh_minutes,
        "output_files": ["shifts.csv", "shifts.json", "employees.json", "calendar_index.json", "calendars/*.ics", "parse_summary.json"],
    }
    (out_dir / "parse_summary.json").write_text(
        json.dumps(combined_summary, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Parse exported UKG/ADP Team Schedule HTML into shift data.")
    parser.add_argument("html_files", nargs="+", type=Path, help="One or more saved Team Schedule HTML files.")
    parser.add_argument("--out-dir", type=Path, default=Path("parsed_schedule"), help="Output directory.")
    parser.add_argument("--timezone", default="America/Vancouver", help="TZID for generated .ics calendars.")
    parser.add_argument("--calendar-location", default="", help="Optional LOCATION value for generated .ics events.")
    parser.add_argument("--alarms", default="1440,180,60", help="Comma-separated reminder minutes before shifts, e.g. 1440,180,60. Use empty string for no alarms.")
    parser.add_argument("--refresh-minutes", default="60", help="Requested refresh interval for subscribed calendars. Default: 60 minutes.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    all_records: list[ShiftRecord] = []
    summaries: list[dict] = []

    for html_file in args.html_files:
        records, summary = parse_team_schedule_html(html_file)
        all_records.extend(records)
        summaries.append(summary)

    all_records = dedupe_records(all_records)
    all_records.sort(key=lambda rec: (rec.employee_name.lower(), rec.start_datetime, rec.end_datetime, rec.shift_id))
    write_outputs(
        all_records,
        summaries,
        args.out_dir,
        tzid=args.timezone,
        location=args.calendar_location,
        alarm_minutes=parse_alarm_minutes(args.alarms),
        refresh_minutes=ics_refresh_minutes(args.refresh_minutes),
    )

    print(f"Parsed {len(all_records)} shifts for {len({r.employee_slug for r in all_records})} employees with shifts.")
    for summary in summaries:
        print(
            f"- {summary['source_file']}: {summary['week_start']} to {summary['week_end']}, "
            f"{summary['shift_count']} shifts, {summary['rendered_employee_count_in_saved_html']} rendered employees"
        )
        if summary.get("warning"):
            print(f"  WARNING: {summary['warning']}")
    print(f"Wrote outputs to: {args.out_dir}")


if __name__ == "__main__":
    main()
