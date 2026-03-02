---
workflow: list-jobs
purpose: Display current cron jobs with human-readable status
---

# ListJobs Workflow

**Read and display all cron jobs in a human-readable format.**

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the ListJobs workflow in the CreateCron skill to show scheduled tasks"}' \
  > /dev/null 2>&1 &
```

Running the **ListJobs** workflow in the **CreateCron** skill to show scheduled tasks...

---

## Step 1: Read Jobs File

Read `./data/cron/jobs.json`

If the file doesn't exist or has no jobs, report: "No cron jobs configured."

---

## Step 2: Format Each Job

For each job, display:

```
[STATUS] **[name]** ([id])
  Schedule: [human-readable schedule] ([timezone])
  Model: [model]
  Last run: [time ago or "never"]
  Status: [ok/error/pending]
  [If errors: "Errors: X consecutive, backoff until [time]"]
  [If one-shot: "Type: one-shot (deletes after success)"]
```

**Status icons:**
- Enabled + healthy: checkmark
- Enabled + errors: warning
- Disabled: pause icon
- Running: spinner

**Schedule translation** (convert cron back to natural language):

| Expression | Display As |
|------------|-----------|
| `0 7 * * *` | "Daily at 7:00 AM" |
| `0 8 * * 1-5` | "Weekdays at 8:00 AM" |
| `30 9 * * 1` | "Mondays at 9:30 AM" |
| `0 9 1 * *` | "1st of month at 9:00 AM" |
| `0 */2 * * *` | "Every 2 hours" |
| kind=every, expr=7200000 | "Every 2 hours" |

---

## Step 3: Show Summary

After the job list, show:

```
Total: [N] jobs ([active] active, [disabled] disabled)
Capacity: [N]/20

[If any jobs in error state:]
Note: [N] job(s) have errors. Use /cron toggle <id> to reset, or check logs.

Manage via Telegram: /cron toggle <id>, /cron remove <id>, /cron run <id>
```
