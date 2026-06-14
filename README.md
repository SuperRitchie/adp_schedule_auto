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

## GitHub Actions + Google Drive upload

This repo includes a workflow at `.github/workflows/capture-schedule.yml` that can run the ADP schedule capture automatically, parse the schedules, and upload the generated files in `parsed_schedule/` to Google Drive.

### Required GitHub secrets

Go to your GitHub repository, then **Settings → Secrets and variables → Actions → New repository secret**.

Add these secrets:

| Secret name | Value |
| --- | --- |
| `ADP_USERNAME_B64` | Base64-encoded ADP username. |
| `ADP_PASSWORD_B64` | Base64-encoded ADP password. |
| `GOOGLE_DRIVE_FOLDER_ID` | The destination Google Drive folder ID. |
| `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_B64` | Base64-encoded Google service account JSON. |

The workflow decodes the ADP base64 secrets and creates a temporary `.env` file during the run. Do not commit a real `.env` file.

To encode your ADP username on macOS:

```bash
printf '%s' 'your_adp_username' | base64 | tr -d '\n' | pbcopy
```

Paste the copied value into the GitHub secret `ADP_USERNAME_B64`.

To encode your ADP password without the shell touching special characters:

```bash
python3 - <<'PY' | pbcopy
import base64
import getpass
password = getpass.getpass('ADP password: ')
print(base64.b64encode(password.encode('utf-8')).decode('ascii'), end='')
PY
```

Paste the copied value into the GitHub secret `ADP_PASSWORD_B64`.

### Google Drive setup

1. Create a Google Cloud project.
2. Enable the Google Drive API.
3. Create a service account.
4. Create/download a JSON key for that service account.
5. Share your destination Google Drive folder with the service account email, usually something like `name@project-id.iam.gserviceaccount.com`.
6. Base64 encode the JSON file and save it as the GitHub secret `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_B64`.

On macOS:

```bash
base64 -i service-account.json | pbcopy
```

Paste the copied value into the GitHub secret.

### Manual workflow run

After committing and pushing the workflow file, go to the repo's **Actions** tab, select **Capture ADP schedule and upload to Google Drive**, then click **Run workflow**.


### Seeing what GitHub Actions saw

The workflow now turns on debug mode in GitHub Actions:

```env
ADP_DEBUG=true
ADP_TRACE=true
```

If the capture step fails, open the failed workflow run and download the artifact named `adp-debug-artifacts`. It can include screenshots, visible text, HTML snapshots, metadata JSON, and a Playwright trace ZIP.

To inspect a Playwright trace locally:

```bash
npx playwright show-trace captures/trace_failure_*.zip
```

The debug artifacts can contain login page details and employee schedule data, so do not share them publicly.

### Important MFA note

The workflow runs headless. If ADP requires MFA every time, GitHub Actions cannot complete that step automatically. In that case, either run the script locally, use a self-hosted runner where you can complete MFA, or keep using the local browser flow.
