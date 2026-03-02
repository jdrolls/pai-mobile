---
workflow: manage-job
purpose: Modify, disable, enable, or remove existing cron jobs
---

# ManageJob Workflow

**Safely modify existing cron jobs — enable/disable, remove, update schedule, or edit prompt.**

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the ManageJob workflow in the CreateCron skill to modify a scheduled task"}' \
  > /dev/null 2>&1 &
```

Running the **ManageJob** workflow in the **CreateCron** skill to modify a scheduled task...

---

## Step 1: Read Current Jobs

Read `./data/cron/jobs.json`

If no jobs exist, report: "No cron jobs to manage. Use CreateJob to create one."

---

## Step 2: Identify Target Job

Match the user's request to a job by:
1. **Name match** (preferred) — fuzzy match on job name
2. **ID match** — exact match on 8-char hex id
3. **Description match** — if user describes the job's purpose, match against `payload.message`

If multiple jobs match, list them and ask the user to specify.
If no jobs match, list all jobs and ask the user to identify which one.

---

## Step 3: Determine Action

| User Intent | Action |
|------------|--------|
| "disable", "pause", "stop", "turn off" | Set `enabled: false` |
| "enable", "resume", "turn on", "start" | Set `enabled: true`, reset errors + backoff |
| "remove", "delete", "get rid of" | Remove job from array |
| "change schedule", "reschedule", "run at different time" | Update `schedule.expr` |
| "change prompt", "update task", "modify what it does" | Update `payload.message` |
| "change model" | Update `model` field |
| "reset errors", "clear backoff" | Reset `state.consecutiveErrors` to 0, `state.backoffUntilMs` to 0 |

---

## Step 4: Apply Change

### Enable/Disable
```json
{
  "enabled": true,
  "state": {
    "consecutiveErrors": 0,
    "backoffUntilMs": 0
  }
}
```
When re-enabling, always reset error state so the job gets a fresh start.

### Remove
Remove the job object from the `jobs` array entirely.

### Update Schedule
1. Parse the new schedule using the same natural language rules from CronReference.md
2. Validate interval >= 5 minutes
3. Update `schedule.kind` and `schedule.expr`

### Update Prompt
1. Apply prompt quality rules from PromptTemplates.md
2. Ensure under 2000 characters
3. Ensure "nothing to report" path exists
4. Update `payload.message`

### Change Model
Only allow: `"sonnet"`, `"haiku"`. Never `"opus"` for cron jobs.

---

## Step 5: Write Back

1. Write the updated JSON to `./data/cron/jobs.json`
2. Pretty-print with 2-space indent
3. Gateway hot-reloads within 60 seconds

---

## Step 6: Confirm

Report what changed:

```
Updated cron job: **[name]** ([id])
Change: [what was modified]
[New value if applicable]

Gateway will pick up the change within 60 seconds.
```

For removals:
```
Removed cron job: **[name]** ([id])
[N] jobs remaining.
```
