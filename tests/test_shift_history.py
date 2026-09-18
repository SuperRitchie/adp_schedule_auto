import json
import tempfile
import unittest
from dataclasses import asdict, replace
from pathlib import Path
from unittest.mock import Mock, patch

import team_schedule_parser as parser
from scripts import upload_to_drive as drive


def shift(day, employee="alex", shift_id="1", title="Cash"):
    return parser.ShiftRecord(
        source_file="schedule.html", employee_name=employee.title(),
        employee_slug=employee, employee_id=employee, primary_job="Cash",
        primary_job_path="Cash", date=day, day_col="day-0",
        start_time="9:00 AM", end_time="5:00 PM",
        start_datetime=f"{day}T09:00:00", end_datetime=f"{day}T17:00:00",
        hours=8, raw_shift_text="9:00 AM - 5:00 PM", shift_title=title,
        shift_departments="Cash", shift_segments="9:00 AM - 5:00 PM Cash",
        shift_detail="Cash", shift_id=shift_id, is_transfer=False,
    )


def week(start="2026-09-20", end="2026-09-26"):
    return dict(week_start=start, week_end=end,
                expected_employee_count_from_header=2,
                rendered_employee_count_in_saved_html=2, warning=None)


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.out = Path(self.temp.name)

    def save_history(self, records):
        (self.out / "shifts.json").write_text(json.dumps([asdict(r) for r in records]))

    def write(self, records, summaries=None):
        parser.write_outputs(records, summaries or [week()], self.out,
                             tzid="America/Vancouver", location="", alarm_minutes=[60])

    def test_retention_edits_cancellations_and_repeat_runs(self):
        past = shift("2026-09-13", "former")
        future = shift("2026-10-10", shift_id="future")
        old = shift("2026-09-21")
        canceled = shift("2026-09-22", shift_id="cancel")
        self.save_history([past, future, old, canceled])
        edited = replace(old, start_time="10:00 AM", start_datetime="2026-09-21T10:00:00")
        new = shift("2026-09-23", "new", "new")
        self.write([edited, new])
        first = json.loads((self.out / "shifts.json").read_text())
        self.assertEqual(len(first), 4)
        self.assertIn(asdict(past), first)
        self.assertIn(asdict(future), first)
        self.assertIn(asdict(edited), first)
        self.assertNotIn(asdict(canceled), first)
        self.write([edited, new])
        self.assertEqual(first, json.loads((self.out / "shifts.json").read_text()))
        summary = json.loads((self.out / "parse_summary.json").read_text())
        self.assertEqual(summary["total_shift_count"], 2)
        self.assertEqual(summary["retained_shift_count"], 2)
        self.assertEqual(summary["stored_shift_count"], 4)
        self.assertTrue((self.out / "calendars/former.ics").exists())

    def test_empty_week_clears_canceled_employee_calendar(self):
        self.write([shift("2026-09-21")])
        self.write([])
        self.write([])
        self.assertNotIn("BEGIN:VEVENT", (self.out / "calendars/alex.ics").read_text())
        self.assertEqual(json.loads((self.out / "shifts.json").read_text()), [])

    def test_disjoint_weeks_preserve_gap(self):
        gap = shift("2026-09-28")
        self.save_history([gap])
        self.write([], [week(), week("2026-10-04", "2026-10-10")])
        self.assertEqual(json.loads((self.out / "shifts.json").read_text()), [asdict(gap)])

    def test_incomplete_capture_leaves_history_untouched(self):
        self.save_history([shift("2026-09-21")])
        before = (self.out / "shifts.json").read_bytes()
        incomplete = {**week(), "rendered_employee_count_in_saved_html": 1}
        with self.assertRaises(ValueError):
            self.write([], [incomplete])
        self.assertEqual(before, (self.out / "shifts.json").read_bytes())

    def test_corrupt_history_is_not_overwritten(self):
        (self.out / "shifts.json").write_text("broken")
        with self.assertRaises(ValueError):
            self.write([shift("2026-09-21")])
        self.assertEqual((self.out / "shifts.json").read_text(), "broken")

    def test_titles_location_and_existing_uids(self):
        old = shift("2026-09-13", title="MEC Cash")
        self.save_history([old])
        self.write([shift("2026-09-21")])
        text = (self.out / "calendars/alex.ics").read_text()
        self.assertEqual(text.count("SUMMARY:MEC Cash\n"), 2)
        self.assertNotIn("MEC MEC", text)
        self.assertEqual(text.count("LOCATION:111 E 2nd Ave\\, Vancouver\\, BC V5T 1B4"), 2)
        self.assertIn("UID:alex:2026-09-13:9:00 AM:5:00 PM:1@adp-schedule-parser", text)

    def test_drive_restore_is_read_only_and_stages_downloads(self):
        service = Mock()
        service.files.return_value.get_media.side_effect = [b"[]", b"[]"]

        def download(buffer, request):
            buffer.write(request)
            downloader = Mock()
            downloader.next_chunk.return_value = (None, True)
            return downloader

        with patch.object(drive, "find_child", return_value={"id": "saved"}), \
             patch.object(drive, "MediaIoBaseDownload", side_effect=download):
            drive.restore_history(service, self.out, "folder")
        self.assertEqual(json.loads((self.out / "shifts.json").read_text()), [])
        service.files.return_value.update.assert_not_called()
        service.files.return_value.create.assert_not_called()
        (self.out / "shifts.json").write_text('["keep"]')
        service.files.return_value.get_media.side_effect = [b"[]", b"broken"]
        with patch.object(drive, "find_child", return_value={"id": "saved"}), \
             patch.object(drive, "MediaIoBaseDownload", side_effect=download):
            with self.assertRaises(ValueError):
                drive.restore_history(service, self.out, "folder")
        self.assertEqual((self.out / "shifts.json").read_text(), '["keep"]')
        with patch.object(drive, "find_child", return_value=None):
            with self.assertRaises(RuntimeError):
                drive.restore_history(service, self.out, "folder")
        self.assertEqual((self.out / "shifts.json").read_text(), '["keep"]')


if __name__ == "__main__":
    unittest.main()
