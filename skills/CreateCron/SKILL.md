---
skill: CreateCron
version: 1.0.0
purpose: Create and manage cron jobs with best practices for the PAI Mobile Gateway
USE WHEN: create cron, schedule task, add cron job, list cron, manage cron, cron status, scheduled task
---

# CreateCron Skill

**Create and manage PAI Mobile Gateway cron jobs with consistent naming, validated schedules, and well-engineered prompts.**

## Customization

**Before executing, check for user customizations at:**
`~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/CreateCron/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the CreateCron skill to manage scheduled tasks"}' \
  > /dev/null 2>&1 &
```

Running the **CreateCron** skill to manage scheduled tasks...

---

## Authoritative References

Before creating or modifying any job, **ALWAYS** read these files:

| File | Purpose |
|------|---------|
| `CronReference.md` (this skill) | JSON schema, schedule syntax, constraints, model selection |
| `PromptTemplates.md` (this skill) | Prompt patterns by job type, anti-patterns, length guidelines |

These are the source of truth. Do not guess field values or invent prompt patterns.

---

## Workflow Routing

| User Intent | Workflow |
|------------|----------|
| Create, add, schedule, new cron job | `Workflows/CreateJob.md` |
| List, show, status, what's running | `Workflows/ListJobs.md` |
| Edit, disable, enable, remove, pause, change | `Workflows/ManageJob.md` |

---

## Key Constraints

- **Minimum interval:** 5 minutes
- **Maximum jobs:** 20
- **Prompt max:** 2000 characters
- **Models:** `sonnet` (default) or `haiku` — never `opus` for cron
- **Timezone:** Configurable via `TIMEZONE` env var (default: `America/Denver`)
- **Hot-reload:** Gateway picks up `jobs.json` changes within 60 seconds

---

## Examples

**"Create a cron job that checks the weather every morning at 7am"**
→ Route to `Workflows/CreateJob.md`
→ Schedule: `0 7 * * *` (cron, daily)
→ Template: Monitor/Check from PromptTemplates.md
→ Model: `haiku` (simple factual lookup)

**"Show me my cron jobs"**
→ Route to `Workflows/ListJobs.md`
→ Read `./data/cron/jobs.json`, format human-readable

**"Disable the weather check"**
→ Route to `Workflows/ManageJob.md`
→ Match by name, set `enabled: false`
