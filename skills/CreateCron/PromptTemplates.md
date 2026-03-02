# Cron Job Prompt Templates

Well-crafted prompts are the difference between useful cron jobs and noisy ones. Every cron job prompt should be specific, bounded, and produce concise output.

## Universal Rules

1. **State the task clearly** in the first sentence
2. **Define success criteria** — what does "done" look like?
3. **Set output boundaries** — max length, format expectations
4. **Include a "nothing to report" path** — prevents unnecessary alerts
5. **Never include credentials, tokens, or file paths** in the prompt itself
6. **Keep under 2000 characters** (hard limit enforced by gateway)

## Anti-Patterns (Never Do These)

| Anti-Pattern | Why It's Bad | Fix |
|-------------|-------------|-----|
| "Check everything and let me know" | Vague, produces essay-length output | Be specific about what to check |
| "Run this daily and report" | No success criteria, no quiet path | Define what "notable" means |
| Including API keys in prompt | Exposed in logs and job store | Use environment or tool access |
| "Do whatever you think is best" | Unbounded, unpredictable | Constrain the action space |
| Prompt > 1000 chars | Wastes context, slower execution | Distill to essentials |

---

## Template: Monitor / Check

**Use for:** Health checks, status monitoring, threshold alerts, availability checks

```
Check [TARGET] and evaluate against these criteria:
- [CONDITION_1]: [threshold or expectation]
- [CONDITION_2]: [threshold or expectation]

If all checks pass and nothing is notable, respond with exactly: "OK"

If any check fails or something needs attention, report:
1. What failed or needs attention
2. Current value vs expected value
3. Suggested action (if obvious)

Keep response under 300 characters if everything is fine, under 500 if alerting.
```

**Example — Weather Check:**
```
Check the current weather and 24-hour forecast for YOUR_CITY.

Alert if any of these conditions:
- Temperature below 20F or above 105F
- Snow accumulation > 2 inches expected
- Severe weather warnings (wind, storms, air quality)
- Rain expected when outdoor plans are likely

If weather is unremarkable, respond with exactly: "OK"

If alerting, include: current conditions, the concern, and timeframe.
```

**Example — Service Health:**
```
Check if the following services are accessible and responding:
- https://example.com (expect 200 OK)
- SSH to myserver (expect connection success)

If all services respond normally: "OK"
If any service is down: report which service, the error, and when it was last known working.
```

---

## Template: Report / Summary

**Use for:** Daily digests, weekly reviews, project status, aggregated updates

```
Generate a concise [FREQUENCY] summary of [TOPIC].

Focus on:
- [ASPECT_1]
- [ASPECT_2]
- [ASPECT_3]

Format as bullet points. Include only items that are actionable or noteworthy.
If nothing notable has changed since the typical baseline, respond with: "No notable updates."

Maximum 500 characters.
```

**Example — Project Status:**
```
Review the current state of active projects in ~/projects/.

For each project with recent activity (modified in last 7 days):
- Project name
- Last modified date
- Any blocking issues visible in the files

If no projects have recent activity: "No active project changes this week."
Keep total response under 500 characters.
```

**Example — Security News Digest:**
```
Check recent security news and advisories relevant to:
- macOS vulnerabilities
- Node.js / npm supply chain issues
- Claude Code or AI tool security

Summarize only HIGH or CRITICAL severity items from the past week.
If nothing critical: "No critical security updates this week."
Maximum 3 items, 100 characters each.
```

---

## Template: Maintenance

**Use for:** Cleanup tasks, backup verification, dependency checks, housekeeping

```
Perform the following maintenance task:
[SPECIFIC_TASK]

Rules:
- [CONSTRAINT_1]
- [CONSTRAINT_2]
- Do not modify files unless explicitly instructed below

Report:
- What was checked
- What action was taken (if any)
- Result (success/failure)

Keep response under 300 characters.
```

**Example — Log Rotation Check:**
```
Check the size of log files in ./data/logs/.

If any log file exceeds 50MB:
- Report the file name and size
- Suggest truncation

If all logs are under 50MB: "OK - logs healthy"
Do not modify or delete any files.
```

**Example — Disk Space Check:**
```
Check available disk space on the primary volume.

Alert if:
- Less than 10GB free
- Usage above 90%

If healthy: "OK - [X]GB free ([Y]% used)"
If alerting: report current usage and largest directories.
```

---

## Template: Research

**Use for:** News monitoring, price tracking, changelog scanning, trend watching

```
Research [TOPIC] focusing on changes or updates since [TIMEFRAME].

Look for:
- [SPECIFIC_THING_1]
- [SPECIFIC_THING_2]

If nothing new or notable: "No updates."
If there are updates, summarize the top [N] items in 1-2 sentences each.
Maximum total response: 500 characters.
```

**Example — Anthropic Updates:**
```
Check for any new announcements, model releases, or API changes from Anthropic in the past week.

Focus on:
- New model versions or capability changes
- Claude Code CLI updates
- API pricing or rate limit changes
- New features or deprecations

If nothing new: "No Anthropic updates this week."
Top 3 items max, 1-2 sentences each.
```

**Example — Dependency Updates:**
```
Check if any dependencies in ./package.json have new major versions available.

Report only MAJOR version bumps (breaking changes).
If no major updates: "All dependencies current."
For each update: package name, current version, available version, changelog highlight.
Max 3 items.
```

---

## Prompt Length Guide

| Job Complexity | Target Length | Example |
|---------------|--------------|---------|
| Simple check | 150-300 chars | Weather, disk space, service ping |
| Standard report | 300-600 chars | Project status, news digest |
| Complex analysis | 600-1000 chars | Security audit, dependency review |
| Maximum | 2000 chars | Only for highly specific multi-step tasks |

**Rule of thumb:** If your prompt is over 800 characters, you're probably asking too much for a single cron job. Split into multiple jobs instead.
