# Cron Reference

Complete reference for the PAI Mobile Gateway cron job system. Read this before creating or modifying jobs.

## Jobs File

**Path:** `./data/cron/jobs.json` (relative to project root)

The gateway hot-reloads this file every 60 seconds. After writing changes, the job will be active within one minute — no restart required.

## CronJob JSON Schema

```json
{
  "version": 1,
  "jobs": [
    {
      "id": "a1b2c3d4",
      "name": "descriptive-job-name",
      "enabled": true,
      "schedule": {
        "kind": "cron",
        "expr": "0 7 * * *",
        "tz": "America/Denver"
      },
      "sessionTarget": "isolated",
      "model": "sonnet",
      "payload": {
        "message": "The prompt/task for this scheduled run"
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
  ]
}
```

## Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | 8-char random hex (generate with first 8 chars of UUID) |
| `name` | string | yes | Lowercase with hyphens, max 50 chars, descriptive. e.g. `daily-weather-check` |
| `enabled` | boolean | yes | `true` to run, `false` to pause |
| `schedule.kind` | `"cron"` or `"every"` | yes | Cron expression or fixed interval |
| `schedule.expr` | string | yes | 5-field cron expression OR milliseconds as string |
| `schedule.tz` | string | yes | IANA timezone (default from `TIMEZONE` env var, e.g. `"America/Denver"`) |
| `sessionTarget` | string | yes | Always `"isolated"` (fresh session per run) |
| `model` | string | no | `"sonnet"` (default), `"haiku"` for simple checks |
| `payload.message` | string | yes | The prompt. Max 2000 chars. |
| `requiresTools` | boolean | yes | `false` for most jobs. `true` only if job needs file/web access. |
| `deleteAfterRun` | boolean | yes | `true` for one-shot tasks, `false` for recurring |
| `state` | object | yes | Always initialize with defaults shown above for new jobs |

## Schedule Syntax

### Natural Language (Preferred)

The gateway's `parseNaturalSchedule()` accepts these patterns:

| Pattern | Example | Cron Expression |
|---------|---------|-----------------|
| `daily TIME` | `daily 7am` | `0 7 * * *` |
| `daily TIME` | `daily 3:30pm` | `30 15 * * *` |
| `weekdays TIME` | `weekdays 9am` | `0 9 * * 1-5` |
| `weekly DAY TIME` | `weekly monday 8am` | `0 8 * * 1` |
| `monthly NTH TIME` | `monthly 1st 9am` | `0 9 1 * *` |
| `every N UNIT` | `every 2h` | kind: `every`, expr: `7200000` |
| `every N UNIT` | `every 30m` | kind: `every`, expr: `1800000` |

### Common Cron Expressions (times interpreted in configured timezone)

| Expression | Meaning |
|------------|---------|
| `0 7 * * *` | Daily at 7:00 AM |
| `0 8 * * 1-5` | Weekdays at 8:00 AM |
| `0 */2 * * *` | Every 2 hours |
| `0 12 * * *` | Daily at noon |
| `30 9 * * 1` | Mondays at 9:30 AM |
| `0 9 1 * *` | 1st of each month at 9:00 AM |
| `0 18 * * 5` | Fridays at 6:00 PM |
| `0 7,12,18 * * *` | Three times daily (7am, noon, 6pm) |

### Cron Field Reference

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6, 0=Sunday)
│ │ │ │ │
* * * * *
```

## Constraints

| Constraint | Value | Enforced By |
|------------|-------|-------------|
| Minimum interval | 5 minutes | `addJob()` validation |
| Maximum jobs | 20 | `addJob()` validation |
| Prompt max length | 2000 characters | `addJob()` truncation |
| Name max length | 50 characters | `sanitizeName()` |
| Timezone | Configurable via `TIMEZONE` env var | Schedule config |
| Tick interval | 60 seconds | Cron engine |
| Job execution timeout | 5 minutes | `executeJob()` |

## Error Handling

Jobs that fail get exponential backoff:

| Consecutive Failures | Backoff Duration |
|---------------------|-----------------|
| 1 | 30 seconds |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 15 minutes |
| 5+ | 1 hour |

The `state.consecutiveErrors` counter resets to 0 on success. Re-enabling a disabled job also resets errors and backoff.

## Model Selection Guide

| Job Type | Model | Why |
|----------|-------|-----|
| Simple checks (weather, status) | `haiku` | Fast, cheap, sufficient for factual lookups |
| Reports and summaries | `sonnet` | Good balance of quality and cost |
| Complex analysis or writing | `sonnet` | Default — handles most tasks well |
| Never use for cron | `opus` | Too expensive and slow for scheduled automation |

## Naming Conventions

Job names should be lowercase with hyphens, descriptive of what the job does:

| Good | Bad |
|------|-----|
| `daily-weather-check` | `weather` |
| `weekday-project-summary` | `summary1` |
| `weekly-security-news` | `sec` |
| `monthly-expense-review` | `Monthly Expense Review` |
