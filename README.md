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
