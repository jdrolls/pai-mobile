# PAI Mobile Integration

Telegram bot that routes messages to Claude Code CLI (`claude -p`) with dual-mode routing and multi-session management.

## Architecture

```
Telegram → index.ts (polling) → classifier.ts (keyword heuristic)
                                   ├── lite.ts → claude -p (stateless, no resume)
                                   └── full.ts → claude -p (session resume)
                                        ↓
                              claude-runner.ts (shared CLI spawner)
                                        ↓
                              sessions.ts (state persistence)
```

**All inference goes through `claude -p` CLI** — no direct Anthropic API calls. Uses Claude Max plan auth, not API billing.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main loop: Telegram polling, auth, commands, message queue, cancellation |
| `src/config.ts` | Loads `.env`, derives paths from project root, exports config |
| `src/claude-runner.ts` | Spawns `claude -p` with clean env. ALL modes route through here |
| `src/classifier.ts` | Synchronous keyword regex → lite/full routing. Zero overhead |
| `src/lite.ts` | Lite mode handler — STATELESS (no session resume) |
| `src/full.ts` | Full mode handler with session resume |
| `src/sessions.ts` | Multi-session state: create, switch, list, persist to disk |
| `src/telegram.ts` | Telegram API: polling, send, typing, chunking, MD→HTML formatting |
| `src/logger.ts` | File + console logger |
| `prompts/lite-system.md` | Lite mode system prompt (uses {{BOT_NAME}}/{{USER_NAME}} placeholders) |
| `prompts/full-system.md` | Full mode system prompt with self-modification protection |
| `manage.sh` | Service lifecycle: install/start/stop/restart/status/logs/dev |

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

## Session Management

- Sessions stored at `data/sessions.json` using atomic writes (write to `.tmp`, then rename)
- **Lite mode is STATELESS** — no `--resume`, fresh system prompt every message. Prevents poisoned context carryover.
- **Full mode uses `--resume`** for conversation continuity via `claudeSessionId`
- Auto-naming: first message content becomes session name

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

## Self-Modification Protection

The full-system.md prompt explicitly forbids Claude from modifying the bot's own source files or restarting the gateway. This prevents a loop where `claude -p` edits source → restarts bot → kills itself → user never gets response.

## Known Gotchas

1. **Only ONE poller per bot token.** If another process polls the same token, both break. `deleteWebhook()` runs at startup to clear conflicts.
2. **Telegram HTML parse mode** for Claude responses. `formatForTelegram()` converts MD→HTML. Commands still use legacy `Markdown`.
3. **Long Claude responses:** Telegram limit is 4096 chars. `sendMessage` chunks at 4000.
4. **Classifier edge cases:** "create a note" matches FULL (contains "create"). Override with `/lite` if misrouted.
5. **Session continuity depends on `claudeSessionId`:** If Claude Code prunes old sessions, resume will fail silently and start fresh.
