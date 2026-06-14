# ADP/UKG Schedule Auto Capture

This is the next step after the recorder. It opens MyADP, logs in using a local `.env` file when a normal login form appears, clicks **Team Schedule**, saves the HTML, and runs the parser.

It does **not** bypass MFA/security checkpoints. By default, it runs in an incognito Playwright context, so no cookies/session are saved after the run. If ADP asks for verification, complete it in the browser window.

## Setup

```bash
cd adp_schedule_auto
npm install
npx playwright install chromium
python3 -m pip install -r requirements.txt
cp .env.example .env
```

Edit `.env` locally:

```env
ADP_URL=https://my.adp.com/#/time
ADP_USERNAME=your_username_here
ADP_PASSWORD=your_password_here
ADP_HEADLESS=false
ADP_INCOGNITO=true
ADP_LOGIN_TIMEOUT_MS=45000

# Keep the file name as .env. The script loads .env from this repo folder.
ADP_SELECT_ALL_JOBS=true
ADP_FILTER_DELAY_MS=700

# 4 = current week plus 3 future weeks.
ADP_WEEKS_TO_CAPTURE=4
ADP_NEXT_WEEK_DELAY_MS=1000
ADP_NEXT_WEEK_TIMEOUT_MS=45000
```

Do not commit `.env`, `.auth`, `captures`, or `parsed_schedule`.

## Run

```bash
node adp_schedule_auto.js
```

Outputs:

- `captures/latest_schedule.html`
- `captures/latest_visible_text.txt`
- `parsed_schedule/shifts.csv`
- `parsed_schedule/shifts.json`
- `parsed_schedule/employees.json`
- `parsed_schedule/calendars/<employee-name>.ics`
- `parsed_schedule/calendar_index.json`
- `parsed_schedule/parse_summary.json`


## Login troubleshooting

If incognito opens the ADP login page but does not type anything, make sure you are running from the repo folder or use the patched script. The script now loads `.env` from both the current working directory and the script directory, then waits for the ADP login form to finish loading before filling fields.

```bash
node adp_schedule_auto.js
```

You should see log lines like:

```text
Waiting up to 45000ms for the ADP login form...
Filling username...
Filling password...
```

If ADP shows MFA/security verification, finish that manually in the browser window. The script will not bypass MFA.


## Schedule capture behavior

By default the script now does three extra things before parsing:

1. Opens the **Locations and jobs** dropdown.
2. Clicks **Select All** and applies the filter.
3. Captures 4 weeks total, which means the current week plus the next 3 weeks.

Useful `.env` settings:

```env
ADP_SELECT_ALL_JOBS=true
ADP_FILTER_DELAY_MS=700
ADP_WEEKS_TO_CAPTURE=4
ADP_NEXT_WEEK_DELAY_MS=1000
ADP_NEXT_WEEK_TIMEOUT_MS=45000
```

If the dropdown is slow to update, raise `ADP_FILTER_DELAY_MS` to `1000` or `1500`.

## Important notes

The trace you uploaded reached the MyADP Time landing page where the **Go to Team Schedule** button is visible. This script starts from that same place and clicks **Team Schedule** automatically.

## Browser mode

Default mode is incognito:

```env
ADP_INCOGNITO=true
```

That means Playwright creates a temporary browser context and deletes cookies/session state when the script ends. This is cleaner and safer for testing, but ADP may ask for MFA every run.

If you later want a reusable local browser profile, set:

```env
ADP_INCOGNITO=false
ADP_PROFILE_DIR=.auth/adp-browser-profile
```

Keep `.auth/` private because it can contain login session cookies.

The Team Schedule grid is virtualized. That means saved HTML may only contain rows that were rendered while scrolling. The script tries to scroll the main page and the largest scrollable grid containers before saving. If the summary says the header employee count is larger than the rendered count, we may need a better grid-specific scrolling selector or an export/print view.

For GitHub Actions, this will only work if ADP allows non-interactive login with your account and does not require MFA/security checkpoint. Be careful with employee schedule data and do not put this into a public repo.
