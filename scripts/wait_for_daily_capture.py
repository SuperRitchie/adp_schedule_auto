#!/usr/bin/env python3
"""hold the runner until the morning capture time in vancouver"""

import argparse
import os
import time
from datetime import datetime, time as clock_time
from zoneinfo import ZoneInfo


VANCOUVER = ZoneInfo("America/Vancouver")


def wait_for_capture(not_before: clock_time, *, now=None, sleep=time.sleep) -> str:
    now = now or (lambda: datetime.now(VANCOUVER))
    started = now().astimezone(VANCOUVER)
    target = datetime.combine(started.date(), not_before, VANCOUVER)
    print(f"Waiting until {target.isoformat()} before logging in to ADP", flush=True)
    while True:
        current = now().astimezone(VANCOUVER)
        if current.date() != started.date():
            raise RuntimeError("Capture date changed while waiting; refusing to refresh the wrong day")
        remaining = target.timestamp() - current.timestamp()
        if remaining <= 0:
            print(f"Ready to refresh only {current.date().isoformat()}", flush=True)
            return current.date().isoformat()
        print(f"{current.isoformat()}: {int(remaining)} seconds until capture", flush=True)
        sleep(min(60, remaining))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--not-before", default="08:15", type=clock_time.fromisoformat)
    args = parser.parse_args()
    capture_date = wait_for_capture(args.not_before)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(f"capture_date={capture_date}\n")


if __name__ == "__main__":
    main()
