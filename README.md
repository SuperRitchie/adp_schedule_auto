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

If you want Gmail-assisted MFA, use a Google OAuth client JSON in `.secrets/gmail_credentials.json` and a token in `.secrets/gmail_token.json`. The script also supports `GOOGLE_CREDENTIALS_JSON_B64` and `GOOGLE_TOKEN_JSON_B64` for CI, and you can override the Gmail search with `ADP_GMAIL_QUERY` if your ADP verification email subject or sender differs.

Useful commands:

```bash
npm run gmail:auth
npm run gmail:check
```

`npm run gmail:auth` opens the Google consent flow and writes a refreshable token to `.secrets/gmail_token.json`. `npm run gmail:check` validates that the token can still refresh and reach Gmail.

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

| Secret name                             | Value                                                               |
| --------------------------------------- | ------------------------------------------------------------------- |
| `ADP_USERNAME_B64`                      | Base64-encoded ADP username. Preferred.                             |
| `ADP_PASSWORD_B64`                      | Base64-encoded ADP password. Preferred.                             |
| `ADP_USERNAME`                          | Optional raw ADP username fallback if the base64 secret is not set. |
| `ADP_PASSWORD`                          | Optional raw ADP password fallback if the base64 secret is not set. |
| `GOOGLE_DRIVE_FOLDER_ID`                | The destination Google Drive folder ID.                             |
| `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_B64` | Base64-encoded Google service account JSON.                         |
| `GOOGLE_CREDENTIALS_JSON_B64`           | Base64-encoded Gmail OAuth client JSON for CI.                      |
| `GOOGLE_TOKEN_JSON_B64`                 | Base64-encoded Gmail OAuth token JSON for CI.                       |

The workflow now passes credentials directly to the Node.js and Python processes through environment variables. It does **not** write ADP credentials into a temporary `.env` file during GitHub Actions. The script prefers `ADP_USERNAME_B64` / `ADP_PASSWORD_B64` when they exist, then falls back to `ADP_USERNAME` / `ADP_PASSWORD`.

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

The workflow prints only safe credential diagnostics, such as value length and a SHA-256 prefix. It does not print the raw password.

For Gmail OAuth in CI, the workflow recreates `.secrets/gmail_credentials.json` and `.secrets/gmail_token.json` from the base64 secrets before it starts ADP automation. It also runs `npm run gmail:check` so a missing `refresh_token` or an `invalid_grant` token gets caught early.

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

## Google Drive upload auth

For a normal personal **My Drive** folder, use Google Drive OAuth credentials instead of a service account. Google service accounts do not have My Drive storage quota, so sharing a personal Drive folder with a service account can fail with `Service Accounts do not have storage quota`.

Create these GitHub repository secrets:

```text
GOOGLE_DRIVE_FOLDER_ID
GOOGLE_DRIVE_CREDENTIALS_JSON_B64
GOOGLE_DRIVE_TOKEN_JSON_B64
```

Local setup:

```bash
mkdir -p .secrets
# Save your Google Cloud OAuth client JSON as:
# .secrets/google_drive_credentials.json
python3 scripts/auth_google_drive_oauth.py   --credentials .secrets/google_drive_credentials.json   --token .secrets/google_drive_token.json

base64 -i .secrets/google_drive_credentials.json | tr -d '\\n' | pbcopy
# paste into GOOGLE_DRIVE_CREDENTIALS_JSON_B64

base64 -i .secrets/google_drive_token.json | tr -d '\\n' | pbcopy
# paste into GOOGLE_DRIVE_TOKEN_JSON_B64
```

Keep the old `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_B64` only if your destination folder is inside a real Google Workspace Shared Drive.

## Subscribable calendar website (optional)

The workflow can also publish the generated `.ics` calendars to a website (for example, a GitHub Pages site) so employees can subscribe from stable URLs.

Published URLs will look like:

```text
https://your-site.example/adp-calendars/
https://your-site.example/adp-calendars/u/my-schedule/
https://your-site.example/adp-calendars/calendars/my-schedule.ics
webcal://your-site.example/adp-calendars/calendars/my-schedule.ics
```

### Required secret for publishing to your website repo

Because this workflow runs from the `adp_schedule_auto` repo but publishes into a separate website repository (for example `username/username.github.io`), add one extra GitHub secret to the `adp_schedule_auto` repo:

| Secret name          | Value                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `WEBSITE_REPO_TOKEN` | A fine-grained GitHub token with **Contents: Read and write** access to the website repository. |

A normal `GITHUB_TOKEN` usually cannot push to a different repository, so this separate token is needed.

### What gets published

After the ADP capture and parser run, the workflow runs:

```bash
python3 scripts/build_calendar_site.py \
  --source-dir parsed_schedule \
  --out-dir calendar_site \
  --base-url https://your-site.example/adp-calendars
```

Then it copies `calendar_site/` into the website repo under:

```text
adp-calendars/
```

The generated website includes:

```text
adp-calendars/index.html
adp-calendars/calendar_index.json
adp-calendars/calendars/<employee-slug>.ics
adp-calendars/u/<employee-slug>/index.html
adp-calendars/robots.txt
```

Each employee gets a stable subscription page and a stable `.ics` URL. When new schedules come out, the workflow replaces the file with the same name, so calendar subscriptions keep pointing at the same URL.

### Calendar refresh hints

Generated `.ics` files include subscription refresh hints:

```text
REFRESH-INTERVAL;VALUE=DURATION:PT1H
X-PUBLISHED-TTL:PT1H
LAST-MODIFIED:<current publish time>
SEQUENCE:<current publish timestamp>
```

The default requested refresh interval is 60 minutes. You can adjust it with:

```env
CALENDAR_REFRESH_MINUTES=60
```

The generated static site also writes a Cloudflare Pages `_headers` file that asks caches to revalidate `.ics` files. GitHub Pages ignores `_headers`, so Google Calendar may still refresh subscribed calendars on Google's own schedule.

### Local test

After you have a `parsed_schedule/` folder locally, test the generated website folder with:

```bash
python3 scripts/build_calendar_site.py \
  --source-dir parsed_schedule \
  --out-dir calendar_site \
  --base-url https://your-site.example/adp-calendars
```

Then open:

```text
calendar_site/index.html
```
