# PAI Mobile Gateway

Telegram bot that routes messages to Claude Code CLI (`claude -p`) with dual-mode routing, multi-session management, session memory, heartbeat monitoring, and cron scheduling.

## Architecture

```
Telegram → index.ts (polling) → classifier.ts (keyword heuristic)
                                   ├── lite.ts → claude -p (sonnet, lite system prompt)
                                   └── full.ts → claude -p (sonnet, full system prompt)
                                        ↓
                              claude-runner.ts (shared CLI spawner)
                                        ↓
                              sessions.ts (state persistence)

Proactive:
  heartbeat.ts (timer) → claude -p (stateless, read-only) → outbound-queue.ts → Telegram
  cron.ts (scheduler)  → claude -p (stateless, isolated)  → outbound-queue.ts → Telegram
```

**All inference goes through `claude -p` CLI** — no direct Anthropic API calls. Uses Claude Max plan auth, not API billing.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main loop: Telegram polling, auth, commands, message queue, proactive startup |
| `src/claude-runner.ts` | Spawns `claude -p` with clean env. ALL modes route through here. Allowlist env for system sessions |
| `src/classifier.ts` | Synchronous keyword regex → lite/full routing. Zero overhead |
| `src/lite.ts` | Lite mode handler — STATELESS (no session resume) |
| `src/full.ts` | Full mode handler with session resume, memory + transcript injection |
| `src/transcript.ts` | Transcript persistence — JSONL append, context formatting for injection |
| `src/memory.ts` | Permanent memory layer — PAI integration, daily logs, MEMORY.md |
| `src/telegram.ts` | Telegram API: polling, send, typing, chunking, MD→HTML, image download |
| `src/sessions.ts` | Multi-session state: create, switch, list, persist to disk |
| `src/heartbeat.ts` | Periodic AI check-in — reads HEARTBEAT.md, alerts only when actionable |
| `src/cron.ts` | Scheduled task executor — natural language schedules, skip-if-running, backoff |
| `src/outbound-queue.ts` | Single async sender — bundling, rate limiting, retry for all outbound |
| `src/config.ts` | Loads `.env` + heartbeat config from project root, validates |
| `src/logger.ts` | File + console logger |
| `prompts/lite-system.md` | Lite mode system prompt (uses `{{BOT_NAME}}`/`{{USER_NAME}}` placeholders) |
| `prompts/full-system.md` | Full mode system prompt with self-modification protection |
| `data/heartbeat-config.json` | Heartbeat config: interval, active hours, model, circuit breaker |
| `data/cron/jobs.json` | Persistent cron job store |
| `manage.sh` | Service lifecycle: install/start/stop/restart/status/logs/dev |
| `com.pai-mobile.plist.example` | launchd auto-start config template |

## Critical: Spawning `claude -p`

These env vars MUST be deleted before spawning `claude`:

```typescript
delete env.CLAUDECODE;              // "cannot launch inside another session"
delete env.CLAUDE_CODE_ENTRYPOINT;
delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
delete env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
delete env.ANTHROPIC_API_KEY;       // Forces Max plan auth instead of API billing
```

**stdin MUST be `'ignore'`** — `'pipe'` causes `claude -p` to hang.
**`--output-format json`** — NOT `stream-json` (which requires `--verbose` with `-p`).

## Configuration

All config via `.env` in project root. See `.env.example` for full list.

Identity (`BOT_NAME`, `USER_NAME`) is injected into prompt templates at runtime via `{{placeholder}}` replacement.

## Permission Mode

Default is `default` — Claude asks for confirmation on risky actions. Users can opt into `acceptEdits` or `bypassPermissions` via `PERMISSION_MODE` in `.env`. The safe default protects against compromised Telegram accounts gaining unrestricted shell access.

System sessions (heartbeat, cron) always use `default` permission mode with an allowlist env that strips all secrets.

## Heartbeat System

- **Stateless** — every tick is a fresh `claude -p` with `--no-session-persistence`. Never `--resume`.
- **HEARTBEAT.md is read-only** — the runner reads the file and passes content as context. AI cannot write to it.
- **Allowlist env** — system sessions only get HOME, PATH, USER, TMPDIR, TERM, LANG, SHELL, CLAUDE_CONFIG_DIR. Bot token and all secrets are stripped.
- **HEARTBEAT_OK = silence** — only actionable alerts reach Telegram. Prevents alarm fatigue.
- **Circuit breaker** — 3 consecutive failures pause heartbeat for 1 hour, sends one alert about the pause.
- **Active hours** — only runs during configured window (default 07:00-22:00).
- **Defers to user** — skips tick if any user message is being processed.
- Config: `data/heartbeat-config.json` (copy from `data/heartbeat-config.example.json`)
- Checklist: `~/.claude/HEARTBEAT.md`

## Cron System

- **Natural language schedules** — "daily 7am", "every 2h", "weekdays 9am", "weekly monday 8am", "monthly 1st 9am", or raw cron expressions.
- **Stateless** — each job runs with `--no-session-persistence` and allowlist env.
- **Skip-if-running** — prevents concurrent executions of the same job.
- **Exponential backoff** — 30s, 1m, 5m, 15m, 1h on consecutive failures.
- **5-minute minimum interval** — prevents runaway schedules.
- **Max 20 jobs** — hard limit to prevent resource exhaustion.
- **Hot-reload** — gateway detects external changes to `jobs.json` via mtime, reloads within 60s.
- **deleteAfterRun** — one-shot jobs auto-remove after successful execution.
- Job store: `data/cron/jobs.json`

## Outbound Queue

- **Single async sender** — all system messages (heartbeat, cron) route through outbound-queue.ts.
- **Bundling** — messages from same source within 15s window are combined (5 cron jobs at 8am = 1 Telegram message, not 5).
- **Rate limiting** — 1s spacing between sends to respect Telegram limits.
- **Retry** — 3 attempts with exponential backoff on send failure.
- Source prefixes: heartbeat=heart, cron=alarm clock.

## Session Management

- Sessions stored at `data/sessions.json` using atomic writes (write to `.tmp`, then rename)
- **Lite mode is STATELESS** — no `--resume`, fresh system prompt every message. Prevents poisoned context carryover.
- **Full mode uses `--resume`** for conversation continuity via `claudeSessionId`
- **Mode stickiness** — once auto-classified as full, session locks to full mode via `modeOverride`. Prevents short follow-up messages ("Yes", "Ok") from dropping to lite and losing context.
- Auto-naming: first message content becomes session name

## Session Memory (Transcript + Permanent Memory)

Three-layer memory system for conversation persistence:

### Layer 1: Transcript (per-session JSONL)
- **Location:** `data/transcripts/{sessionId}.jsonl`
- **Format:** Append-only JSONL: `{role, content, ts}`
- **Written:** After every full-mode message/response pair
- **Purpose:** Safety net for when `--resume` fails (Claude prunes sessions)
- **Injection:** ONLY when `--resume` is unavailable — never concurrent with successful resume
- Simple truncation (last N entries within 8K char budget), NOT LLM compaction

### Layer 2: Permanent Memory (MEMORY.md)
- **Location:** `data/memory/MEMORY.md` (local) + `~/.claude/MEMORY/TELEGRAM/MEMORY.md` (PAI-integrated)
- **Size cap:** 8,000 characters (oldest-first rotation)
- **Loaded:** Injected into system prompt on new sessions only
- **Purpose:** Cross-session knowledge that survives session boundaries

### Layer 3: Daily Logs
- **Location:** `data/memory/daily/YYYY-MM-DD.md` (local) + `~/.claude/MEMORY/RELATIONSHIP/YYYY-MM/YYYY-MM-DD.md` (PAI-integrated)
- **Format:** Timestamped interaction summaries (user snippet + assistant snippet)
- **Written:** After every full-mode exchange (async, best-effort)
- **Purpose:** Audit trail and daily interaction history; PAI path auto-surfaces in desktop sessions

### Resume Failure Recovery
- Detected by comparing returned `session_id` to stored `claudeSessionId`
- Different IDs = session was pruned, resume failed silently
- Next call prepends transcript context to user message (compatible with --resume)
- `contextRecovery` flag on session tracks this state

### Key Design Decisions (from red team analysis)
- `--resume` is PRIMARY context mechanism; transcript is FALLBACK only
- Transcript NEVER injected alongside successful `--resume` (avoids duplicate context / role confusion)
- Simple truncation over LLM compaction (deterministic, zero latency, no semantic drift)
- File-based only, no database (matches PAI canonical patterns)

## Message Queue & Cancellation

- Messages received while processing are queued with "Queued" notification
- **Queue is persisted to `data/queue.json`** — survives crashes, reloaded on startup
- Queue drains FIFO after current task completes
- `/cancel` kills current `claude -p` process via AbortController and clears queue
- Long tasks (>15s) trigger a "taking a few minutes" notification

## Rate Limiting

- Per-chat: max `MAX_MESSAGES_PER_MINUTE` messages in a 60s sliding window (default: 20)
- Global: max `MAX_CONCURRENT_CLAUDE` simultaneous `claude -p` processes (default: 3)
- Rate-limited messages get a friendly rejection; excess concurrent requests are queued

## Reliability

- **Atomic file writes** — sessions.json and queue.json use write-to-tmp-then-rename (atomic on POSIX)
- **`activeClaude` counter** — tracks concurrent processes, decrements in `finally` with `Math.max(0, n-1)` safety
- **`lastUpdateId` persistence** — Telegram update offset saved to `data/last-update-id`, prevents re-processing messages after restart

## Commands

`/new [name]`, `/sessions`, `/switch <id>`, `/lite`, `/full`, `/auto`, `/cancel`, `/status`, `/help`

**Proactive commands:** `/heartbeat`, `/cron [list|add|remove|toggle|run]`, `/pause`, `/resume`

- `/pause` — stops ALL proactive behavior (heartbeat + cron) with one command
- `/resume` — restarts proactive behavior
- `/cron add "name" "schedule" "prompt"` — create a cron job with natural language schedule

## Skill Command Discovery

At startup, the gateway scans `~/.claude/skills/` and registers all discovered skills as Telegram bot commands.

### How it works
1. `src/skills.ts` reads each `SKILL.md` frontmatter (name + description)
2. Names are normalized to Telegram-safe commands (lowercase, no hyphens — e.g., `AlexHormoziPitch` → `/alexhormozipitch`)
3. Built-in commands (`/new`, `/sessions`, etc.) take priority — no skill can override them
4. All commands registered via `setMyCommands` API at startup — visible in Telegram's `/` menu
5. When a user sends `/research quantum computing`, it's rewritten to `"Use the Research skill: quantum computing"` and routed through full mode
6. `full-system.md` has a skill routing hint that tells Claude to invoke skills via the Skill tool

### Key files
| File | Role |
|------|------|
| `src/skills.ts` | Skill discovery — scans dirs, parses YAML frontmatter |
| `src/telegram.ts` | `registerBotCommands()` — wraps `setMyCommands` API |
| `src/index.ts` | `skillMap`, routing logic, startup registration, `/help` |
| `prompts/full-system.md` | Skill routing hint for Claude |

### Notes
- Skills are scanned once at startup. Restart gateway to pick up new skills.
- Telegram practical limit: ~50 total commands (13 built-in + up to 37 skills in menu). All skills are still routable — only the menu registration is capped.
- Registration is non-fatal — if `setMyCommands` fails, bot works without command menu.
- `CORE` and `PAI` directories are excluded (internal infrastructure).

## Known Gotchas

1. **Only ONE poller per bot token.** If another process polls the same token, both break. `deleteWebhook()` runs at startup to clear conflicts.
2. **Telegram HTML parse mode** for Claude responses. `formatForTelegram()` converts MD→HTML. Commands still use legacy `Markdown`.
3. **Long Claude responses:** Telegram limit is 4096 chars. `sendMessage` chunks at 4000.
4. **Classifier edge cases:** "create a note" matches FULL (contains "create"). Override with `/lite` if misrouted.
5. **Session continuity depends on `claudeSessionId`:** If Claude Code prunes old sessions, resume will fail silently. The transcript layer detects this and injects context recovery on the next message.
