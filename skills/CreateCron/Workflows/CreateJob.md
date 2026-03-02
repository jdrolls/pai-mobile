---
workflow: create-job
purpose: Create a new cron job with validated schedule, well-crafted prompt, and correct schema
---

# CreateJob Workflow

**Create production-quality cron jobs for the PAI Mobile Gateway with consistent naming, validated schedules, and well-engineered prompts.**

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the CreateJob workflow in the CreateCron skill to create a scheduled task"}' \
  > /dev/null 2>&1 &
```

Running the **CreateJob** workflow in the **CreateCron** skill to create a scheduled task...

---

## Step 1: Read Reference Materials

**REQUIRED FIRST:** Read these files before proceeding:
- `~/.claude/skills/CreateCron/CronReference.md` — Schema, constraints, schedule syntax
- `~/.claude/skills/CreateCron/PromptTemplates.md` — Prompt patterns by job type

---

## Step 2: Gather Requirements

Extract or ask the user for these details:

| Requirement | Question | Default |
|------------|----------|---------|
| **Task** | What should this job do? | (required) |
| **Schedule** | How often / when should it run? | (required) |
| **Job Type** | Monitor, Report, Maintenance, or Research? | Infer from task |
| **Model** | Which model? | `sonnet` (use `haiku` for simple checks) |
| **One-shot?** | Run once then delete, or recurring? | Recurring (`false`) |
| **Tools needed?** | Does the job need file/web access? | `false` |

If the user provided enough information in their request, proceed without asking. Only ask for clarification when critical details are ambiguous.

---

## Step 3: Validate Schedule

Map the user's natural language schedule to a cron expression:

1. Use the natural language mapping from CronReference.md
2. Verify the interval is >= 5 minutes
3. Confirm timezone matches configured `TIMEZONE` env var
4. For ambiguous times, prefer the configured timezone interpretation

**Schedule Mapping Examples:**

| User Says | kind | expr |
|-----------|------|------|
| "every morning at 7" | `cron` | `0 7 * * *` |
| "weekdays at 8am" | `cron` | `0 8 * * 1-5` |
| "every 2 hours" | `every` | `7200000` |
| "every Monday at 9:30am" | `cron` | `30 9 * * 1` |
| "twice a day, morning and evening" | `cron` | `0 7,18 * * *` |
| "first of every month at 9am" | `cron` | `0 9 1 * *` |

If the schedule is ambiguous, ask: "Did you mean [interpretation A] or [interpretation B]?"

---

## Step 4: Craft the Payload Prompt

This is the most important step. A good prompt produces concise, actionable output. A bad prompt creates noise.

1. **Identify the job type** from the user's request:
   - Checking a condition → **Monitor/Check** template
   - Generating a summary → **Report/Summary** template
   - Running a cleanup or housekeeping task → **Maintenance** template
   - Tracking changes or news → **Research** template

2. **Apply the matching template** from PromptTemplates.md:
   - Fill in the specific targets, conditions, and thresholds
   - Include a "nothing to report" path (prevents unnecessary alerts)
   - Set output length expectations

3. **Validate the prompt:**
   - Is it under 2000 characters? (hard limit)
   - Is there a clear success path AND a "nothing notable" path?
   - Are instructions specific enough that a fresh AI session can execute them?
   - Does it avoid: vague directives, credential embedding, unbounded output?

4. **Target prompt length:**
   - Simple checks: 150-300 chars
   - Standard reports: 300-600 chars
   - Complex analysis: 600-1000 chars
   - Absolute max: 2000 chars

---

## Step 5: Build the Job JSON

Assemble the CronJob object:

```javascript
// Generate an 8-char hex ID
const id = crypto.randomUUID().slice(0, 8);
```

```json
{
  "id": "[8-char-hex]",
  "name": "[lowercase-with-hyphens]",
  "enabled": true,
  "schedule": {
    "kind": "[cron or every]",
    "expr": "[expression or milliseconds]",
    "tz": "America/Denver"
  },
  "sessionTarget": "isolated",
  "model": "[sonnet or haiku]",
  "payload": {
    "message": "[crafted prompt from Step 4]"
  },
  "requiresTools": false,
  "deleteAfterRun": false,
  "state": {
    "lastRunAtMs": 0,
    "lastStatus": "pending",
    "consecutiveErrors": 0,
    "isRunning": false,
    "backoffUntilMs": 0
  }
}
```

**Naming rules:**
- Lowercase with hyphens: `daily-weather-check`, `weekday-project-summary`
- Descriptive of what the job does, not when it runs
- Max 50 characters

**Checklist before writing:**
- [ ] `id` is 8-char hex (unique)
- [ ] `name` is lowercase-with-hyphens, descriptive, <= 50 chars
- [ ] `schedule.tz` matches configured timezone
- [ ] `model` is `"sonnet"` or `"haiku"` (never `"opus"`)
- [ ] `payload.message` is under 2000 chars
- [ ] `payload.message` has a "nothing to report" path
- [ ] `state` uses all default values
- [ ] `deleteAfterRun` matches user intent (one-shot vs recurring)

---

## Step 6: Write to jobs.json

1. **Read** the current file:
   ```
   ./data/cron/jobs.json
   ```

2. **Check** the job count (max 20)

3. **Append** the new job to the `jobs` array

4. **Write** the updated JSON back to the file (pretty-printed with 2-space indent)

5. The gateway will **hot-reload** the file within 60 seconds

---

## Step 7: Confirm to User

Report what was created:

```
Created cron job: **[name]** ([id])
Schedule: [human-readable schedule] ([timezone])
Model: [model]
Next run: ~[estimated next run time]
Type: [recurring / one-shot]

The gateway will pick this up within 60 seconds.
Use /cron list in Telegram to verify, or /cron toggle [id] to pause.
```

---

## Validation Gates

Before declaring the job created, verify:

1. **Schema valid** — All required fields present, correct types
2. **Schedule valid** — Expression parses correctly, interval >= 5 minutes
3. **Prompt quality** — Specific, bounded, has quiet path, under 2000 chars
4. **File written** — jobs.json updated successfully
5. **No duplicates** — No existing job with same name
