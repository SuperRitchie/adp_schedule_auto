# MEC schedule email trigger

This repository can be triggered when the MEC schedule email arrives by sending a GitHub `repository_dispatch` event named `mec_schedule_posted`.

The workflow still supports manual runs and the existing scheduled backup run. The email trigger is only an additional way to start the same capture job when the schedule-posted email arrives.

## Expected MEC email

Your recent schedule emails look like these:

```text
Rick Meinhardt
Schedule is Posted July ...

Rick Meinhardt
schedule is posted July 1...

Laura Chapple
Schedule June 7-13
```

Because the capitalization and wording can vary, filter broadly on `schedule`, then use a condition with `toLower(...)` before calling GitHub.

## GitHub token

Create a GitHub fine-grained personal access token for Power Automate.

Use:

```text
Repository access: Only select repositories
Repository: SuperRitchie/adp_schedule_auto
Permissions: Contents → Read and write
```

Store the token in Power Automate only. Do not commit it to this repository.

## Power Automate flow

Create an automated cloud flow:

```text
Name: Run ADP calendar when MEC schedule is posted
Trigger: Office 365 Outlook → When a new email arrives (V3)
Mailbox: ritchie.kumar@mec.ca
Folder: Inbox
Subject Filter: schedule
Include Attachments: No
Only with Attachments: No
```

Add a condition before the HTTP call. Use this expression in advanced/expression mode:

```text
@and(
  contains(toLower(triggerOutputs()?['body/subject']), 'schedule'),
  or(
    contains(toLower(triggerOutputs()?['body/subject']), 'posted'),
    contains(triggerOutputs()?['body/subject'], '-')
  )
)
```

This matches the current `Schedule is Posted ...` emails and also the older `Schedule June 7-13` style.

In the **Yes** branch, add an HTTP POST action:

```text
POST https://api.github.com/repos/SuperRitchie/adp_schedule_auto/dispatches
```

Headers:

```json
{
  "Accept": "application/vnd.github+json",
  "Authorization": "Bearer YOUR_GITHUB_FINE_GRAINED_PAT",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json"
}
```

Body:

```json
{
  "event_type": "mec_schedule_posted",
  "client_payload": {
    "mailbox": "ritchie.kumar@mec.ca",
    "subject": "<dynamic email Subject>",
    "from": "<dynamic From>",
    "source": "power_automate"
  }
}
```

Use the dynamic **Subject** field from the Outlook trigger for `client_payload.subject` and the dynamic **From** field for `client_payload.from`.

## Manual test with curl

You can test the GitHub side before building Power Automate:

```bash
curl -L -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer YOUR_GITHUB_FINE_GRAINED_PAT" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/SuperRitchie/adp_schedule_auto/dispatches \
  -d '{
    "event_type": "mec_schedule_posted",
    "client_payload": {
      "mailbox": "ritchie.kumar@mec.ca",
      "subject": "Schedule is Posted July 19 - July 25, 2026",
      "from": "Rick Meinhardt",
      "source": "manual_curl_test"
    }
  }'
```

A successful dispatch usually returns no response body. Check the GitHub Actions tab for a new workflow run.

## Notes

The HTTP action in Power Automate may require a premium connector depending on the MEC/Microsoft license. If HTTP is unavailable, forward matching MEC schedule emails to Gmail and use Google Apps Script to call the same GitHub dispatch endpoint.
