import tempfile
import unittest
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

import team_schedule_parser as parser
from scripts.wait_for_daily_capture import VANCOUVER, wait_for_capture


def schedule_html(*, capture_date="2026-10-23", missing_column=False):
    rows = []
    for name in ("Alex", "Blair"):
        cells = []
        for day in range(7):
            if missing_column and name == "Blair" and day == 5:
                continue
            cells.append(f'''<div col-id="day-{day}">
              <div class="location-schedule-cell__entity" automation-id="location_schedule_cell_shift_{name}-{day}"
                data-adp-shift-detail="9:00 AM - 5:00 PM Cash">
                <span class="location-schedule-cell__title">9:00 AM - 5:00 PM (8h)</span>
              </div></div>''')
        rows.append(f'''<div role="row"><div col-id="name">
          <span class="location-schedule-employee-cell__name">{name}</span>
          </div>{''.join(cells)}</div>''')
    marker = f'data-adp-capture-date="{capture_date}"' if capture_date else ""
    return f'''<div>10/18/2026 - 10/24/2026</div>
      <div class="ag-header-cell" col-id="name">Name [2]</div>
      <div id="adp-schedule-captured-virtual-rows" class="ag-center-cols-container" {marker}>
      {''.join(rows)}</div>'''


class DailyParserTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "schedule.html"

    def test_daily_html_only_parses_friday(self):
        self.path.write_text(schedule_html())
        records, summary = parser.parse_team_schedule_html(self.path, date(2026, 10, 23))
        self.assertEqual(len(records), 2)
        self.assertEqual({r.date for r in records}, {"2026-10-23"})
        self.assertEqual({r.day_col for r in records}, {"day-5"})
        self.assertEqual(summary["captured_day_employee_count"], 2)
        self.assertIsNone(summary["warning"])

    def test_daily_html_cannot_accidentally_replace_a_full_week(self):
        self.path.write_text(schedule_html())
        for requested in (None, date(2026, 10, 22)):
            with self.subTest(requested=requested), self.assertRaises(ValueError):
                parser.parse_team_schedule_html(self.path, requested)

    def test_missing_day_cell_is_not_treated_as_a_cancellation(self):
        self.path.write_text(schedule_html(missing_column=True))
        records, summary = parser.parse_team_schedule_html(self.path, date(2026, 10, 23))
        with self.assertRaises(ValueError):
            parser.merge_shift_history(records, [summary], self.path.parent / "history.json")

    def test_full_week_still_includes_all_seven_days(self):
        self.path.write_text(schedule_html(capture_date=""))
        records, summary = parser.parse_team_schedule_html(self.path)
        self.assertEqual(len(records), 14)
        self.assertNotIn("capture_date", summary)


class CaptureTimeTests(unittest.TestCase):
    def test_waits_until_0815_on_both_sides_of_dst(self):
        for day in ("2026-10-23", "2026-11-02"):
            current = datetime.fromisoformat(f"{day}T08:13:00").replace(tzinfo=VANCOUVER)
            sleeps = []

            def now():
                return current.astimezone(timezone.utc)

            def sleep(seconds):
                nonlocal current
                sleeps.append(seconds)
                current += timedelta(seconds=seconds)

            self.assertEqual(wait_for_capture(time(8, 15), now=now, sleep=sleep), day)
            self.assertEqual(sum(sleeps), 120)
            self.assertTrue(all(seconds <= 60 for seconds in sleeps))

    def test_late_runner_starts_immediately_on_its_local_date(self):
        def sleep(seconds):
            self.fail("Late runner should not sleep")

        result = wait_for_capture(time(8, 15), now=lambda: datetime(2026, 10, 23, 23, 50, tzinfo=VANCOUVER), sleep=sleep)
        self.assertEqual(result, "2026-10-23")

    def test_0830_is_supported(self):
        now = datetime(2026, 10, 23, 8, 30, tzinfo=VANCOUVER)
        self.assertEqual(wait_for_capture(time(8, 30), now=lambda: now), "2026-10-23")


if __name__ == "__main__":
    unittest.main()
