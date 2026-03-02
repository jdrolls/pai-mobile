# PAI Mobile

**Your AI infrastructure, in your pocket.**

PAI Mobile is a Telegram gateway that connects your phone to [Claude Code](https://docs.anthropic.com/en/docs/claude-code), giving you full AI assistant access from anywhere. Send a message on Telegram, get a Claude Code response back — including file access, terminal commands, and multi-turn conversations.

> **Status: v2.1.0** — Stable release with session memory, image handling, and PAI memory integration. Running daily on the author's machine. Your feedback will shape what this becomes.

## Why This Exists

PAI is powerful, but it lives on your laptop. You have to be at your desk, in a terminal, to use it. That's a real limitation — ideas don't wait for you to sit down.

PAI Mobile was inspired by [OpenClaw](https://github.com/danielmiessler/openclaw)'s vision of autonomous, always-accessible AI. OpenClaw showed what's possible when your AI can reach you proactively — checking in, running scheduled tasks, alerting you when something matters. PAI Mobile brings that same philosophy to the PAI ecosystem:

- **Reactive** — Ask questions, run tasks, manage files from your phone
- **Proactive** — Heartbeat monitoring and scheduled tasks that reach out to *you*
- **Autonomous** — Runs as a system service, survives reboots, self-recovers from crashes

This is a PAI plugin, not a replacement. It extends your existing PAI setup with a mobile interface. Your skills, memory, and configuration all work through it.

## What You Can Do

**From your phone:**
- Ask quick questions (weather, lookups, calculations) — routed to fast, stateless lite mode
- Run complex multi-turn tasks (coding, file management, research) — routed to full Claude Code with tool access
- **Send images** — photos and image documents are downloaded and forwarded to Claude for analysis
- **Persistent context** — conversations remember what you were talking about, even across session restarts
- Switch between multiple conversation sessions
- Cancel running tasks, manage your queue

**Proactively (the bot reaches out to you):**
- **Heartbeat** — Periodic check-ins that evaluate a checklist you define. Only alerts when something is actionable. Silence means everything is fine.
- **Cron** — Scheduled tasks with natural language ("daily 7am", "weekdays 9am", "every 2 hours"). One-shot or recurring.

**Commands:**
| Command | What it does |
|---------|-------------|
| `/new [name]` | Start a new conversation session |
| `/sessions` | List all sessions |
| `/switch <id>` | Switch to a different session |
| `/lite` | Lock to lite mode (fast, no tools) |
| `/full` | Lock to full mode (Claude Code with tools) |
| `/auto` | Restore auto-routing |
| `/cancel` | Kill current task, clear queue |
| `/status` | Show session info |
| `/pause` | Pause all proactive behavior |
| `/resume` | Resume proactive behavior |
| `/heartbeat` | Check heartbeat status |
| `/cron list` | List scheduled tasks |
| `/cron add "name" "schedule" "prompt"` | Create a scheduled task |
| `/cron remove <id>` | Delete a scheduled task |
| `/cron toggle <id>` | Enable/disable a task |
| `/cron run <id>` | Manually trigger a task |
| `/help` | Show all commands |

## Prerequisites

Before you start, you need:

1. **Claude Code CLI** — installed and authenticated. Run `claude --version` to verify. If not installed: [docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code)
2. **Claude Max subscription** — PAI Mobile uses `claude -p` which bills to your Max plan, not API credits. No API key needed.
3. **Node.js 18+** — Run `node --version` to check. Install via [nodejs.org](https://nodejs.org) or `brew install node`
4. **A Telegram bot token** — You'll create one in the next section
5. **Your Telegram chat ID** — You'll get this in the next section

## Setup (Step by Step)

### Step 1: Create Your Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a display name (e.g., "My PAI Mobile")
4. Choose a username (must end in `bot`, e.g., `my_pai_mobile_bot`)
5. BotFather will reply with your **bot token** — save it, you'll need it next

### Step 2: Get Your Chat ID

1. Open Telegram and search for **@userinfobot**
2. Send `/start`
3. It replies with your **chat ID** (a number like `123456789`) — save it

### Step 3: Clone and Install

```bash
git clone https://github.com/jdrolls/pai-mobile.git
cd pai-mobile
npm install
```

### Step 4: Configure

```bash
cp .env.example .env
```

Open `.env` in your editor and fill in:

```bash
# Required — your bot identity
BOT_NAME=MyBot          # Whatever you want to call your bot
USER_NAME=YourName      # Your name (used in system prompts)

# Required — from Steps 1 and 2
TELEGRAM_BOT_TOKEN=your-bot-token-here
TELEGRAM_CHAT_ID=your-chat-id-here
```

That's the minimum. The rest of `.env` has optional settings with sensible defaults:

| Variable | Default | What it controls |
|----------|---------|-----------------|
| `BOT_NAME` | `PAI Mobile` | Bot's name in prompts |
| `USER_NAME` | `User` | Your name in prompts |
| `TELEGRAM_BOT_TOKEN` | — | **Required.** From @BotFather |
| `TELEGRAM_CHAT_ID` | — | **Required.** Comma-separated for multiple users |
| `TIMEZONE` | `America/Denver` | For heartbeat active hours and cron schedules |
| `LITE_MODEL` | `sonnet` | Model for lite mode |
| `FULL_MODEL` | `sonnet` | Model for full mode |
| `PERMISSION_MODE` | `default` | Claude Code permission mode (see Security) |
| `MAX_MESSAGES_PER_MINUTE` | `20` | Rate limit per chat |
| `MAX_CONCURRENT_CLAUDE` | `3` | Max simultaneous `claude -p` processes |

### Step 5: Run It

```bash
# Dev mode (auto-restarts on file changes)
npm run dev
```

Open Telegram, find your bot, and send it a message. You should get a response within a few seconds.

If it works — you're done with basic setup.

### Step 6 (Optional): Install as a System Service

To keep your bot running permanently on macOS (survives reboots, auto-restarts on crash):

```bash
# Install the launchd service
./manage.sh install

# Start it
./manage.sh start

# Verify it's running
./manage.sh status
```

Other service commands:
```bash
./manage.sh stop       # Stop the service
./manage.sh restart    # Restart
./manage.sh logs       # Tail the log file
./manage.sh uninstall  # Remove the service
```

### Step 7 (Optional): Enable Heartbeat

The heartbeat system periodically checks a file you define and alerts you only when something needs attention.

1. Copy the example config:
   ```bash
   cp data/heartbeat-config.example.json data/heartbeat-config.json
   ```

2. Edit `data/heartbeat-config.json` and set `"enabled": true`

3. Create your heartbeat checklist at `~/.claude/HEARTBEAT.md`:
   ```markdown
   # Heartbeat Checklist

   Check these and alert me only if something needs action:

   - [ ] Are any critical services down?
   - [ ] Any disk usage above 90%?
   - [ ] Any failed cron jobs in the last hour?
   ```

4. Restart the gateway: `./manage.sh restart`

The heartbeat runs hourly during active hours (default 7am–10pm). If everything is fine, it stays silent. If something is actionable, you get a Telegram message.

### Step 8 (Optional): Set Up Cron Jobs

Schedule recurring AI tasks. Add them via Telegram:

```
/cron add "morning-briefing" "daily 7am" "Give me a brief summary of today's calendar and priorities"
```

Or use standard cron expressions:

```
/cron add "weekly-review" "0 9 * * 1" "Review my project status and flag anything behind schedule"
```

**Natural language schedules supported:** `daily 7am`, `weekdays 9am`, `every 2h`, `weekly monday 8am`, `monthly 1st 9am`

## How It Works

```
Telegram → index.ts (polling) → classifier.ts (keyword routing)
                                   ├── lite.ts → claude -p (stateless, no tools)
                                   └── full.ts → claude -p (session resume, full tools)
                                        ↓
                              transcript.ts (JSONL safety net)
                              memory.ts (permanent memory + daily logs)

Proactive systems:
  heartbeat.ts → claude -p (read-only) → outbound-queue.ts → Telegram
  cron.ts      → claude -p (isolated)  → outbound-queue.ts → Telegram
```

- **All inference goes through `claude -p`** — no direct API calls. Uses your Claude Max subscription.
- **Lite mode** is stateless — every message gets a fresh context. Fast, cheap, no context poisoning.
- **Full mode** resumes sessions — multi-turn conversation continuity via `--resume`.
- **Session memory** — three-layer persistence: transcript JSONL (safety net), permanent memory (MEMORY.md), and daily interaction logs. See [Session Memory](#session-memory) below.
- **Mode stickiness** — sessions auto-lock to full mode for context continuity. Use `/lite` to opt out.
- **Resume failure detection** — if Claude prunes a session, the bot detects it and re-injects conversation context.
- **Classifier** uses keyword regex, not LLM — zero overhead routing.
- **Outbound queue** bundles proactive messages (5 cron results at 8am = 1 Telegram message, not 5).
- **Image support** — photos and image documents sent via Telegram are downloaded and forwarded to Claude.

## Customization

### System Prompts

Edit `prompts/lite-system.md` and `prompts/full-system.md` to customize your bot's personality and behavior. Use `{{BOT_NAME}}` and `{{USER_NAME}}` placeholders — they're replaced at runtime from your `.env` config.

### Classifier

Edit `src/classifier.ts` to tune which messages route to lite vs full mode. The default uses keyword patterns — add your own for your use case. Override anytime with `/lite` or `/full`.

### Cron Skill

The included `skills/CreateCron/` skill lets Claude create cron jobs programmatically from natural language when running in full mode. It can read and write to `data/cron/jobs.json` directly.

## Session Memory

PAI Mobile uses a three-layer memory system for conversation persistence:

### Layer 1: Transcript (per-session safety net)
- **Location:** `data/transcripts/{sessionId}.jsonl`
- **Format:** Append-only JSONL with `{role, content, ts}` entries
- **Purpose:** When Claude prunes a session and `--resume` fails silently, the transcript provides fallback context
- **Injection:** Only when `--resume` is unavailable — never alongside a successful resume
- Simple truncation (last N entries within character budget), not LLM compaction

### Layer 2: Permanent Memory (MEMORY.md)
- **Location:** `~/.claude/MEMORY/TELEGRAM/MEMORY.md` + local `data/memory/MEMORY.md`
- **Size cap:** 8,000 characters
- **Loaded:** Injected into system prompt on new sessions
- **Purpose:** Cross-session knowledge that survives session boundaries
- Integrates with PAI's native memory system — desktop Claude Code sessions can discover Telegram context

### Layer 3: Daily Logs
- **Location:** `~/.claude/MEMORY/RELATIONSHIP/YYYY-MM/YYYY-MM-DD.md` + local `data/memory/daily/`
- **Format:** Timestamped interaction bullets (e.g., `[Telegram 14:32] Discussed X`)
- **Purpose:** PAI's `LoadContext` hook automatically reads today + yesterday's relationship notes, so Telegram interactions surface in desktop sessions with zero configuration

### Resume Failure Recovery
- Detected by comparing the returned `session_id` to the stored `claudeSessionId`
- Different IDs = session was pruned, resume failed silently
- Next call prepends transcript context to the user message
- `contextRecovery` flag on the session tracks this state

### Design Decisions
- `--resume` is the **primary** context mechanism; transcript is a **fallback** only
- Transcript is **never** injected alongside a successful `--resume` (avoids duplicate context)
- Simple truncation over LLM compaction (deterministic, zero latency, no semantic drift)
- File-based only, no database

## Security

- **Chat ID whitelist** — Only Telegram accounts listed in `TELEGRAM_CHAT_ID` can interact with the bot. All other messages are silently dropped.
- **Default permission mode is `default`** — Claude asks for confirmation before risky actions (file edits, shell commands). You can change this to `acceptEdits` or `bypassPermissions` in `.env`, but understand: a compromised Telegram account would gain whatever permissions you grant.
- **Self-modification protection** — The full mode system prompt prevents Claude from modifying the bot's own source code or restarting its process.
- **System session isolation** — Heartbeat and cron processes run with a stripped environment (allowlist: HOME, PATH, USER, TMPDIR, TERM, LANG, SHELL, CLAUDE_CONFIG_DIR only). No secrets, no bot token.
- **Rate limiting** — Per-chat message limits and global concurrent process limits prevent resource exhaustion.
- **Never commit your `.env`** — It's in `.gitignore`.

## Known Limitations

- **macOS only** for the launchd service management. The bot itself runs anywhere Node.js does, but `manage.sh install` generates macOS-specific plists. Linux systemd support is planned.
- **One poller per bot token** — If another process polls the same Telegram token, both break. The bot runs `deleteWebhook()` at startup to clear conflicts.
- **Telegram message limit** — Responses over 4096 characters get chunked. Complex output may look fragmented.
- **Session pruning** — If Claude Code prunes old sessions, `--resume` fails silently. The transcript safety net detects this and recovers context automatically, but the first response after pruning may have slightly less context.

## Feedback

If you're a PAI community member testing this out, I'd love to hear:

- What works well, what doesn't
- What features you'd want next
- Any bugs or unexpected behavior
- How you're using it — what tasks, what schedules

Open an issue on this repo, or drop feedback in the [PAI Discussions](https://github.com/danielmiessler/fabric/discussions).

## License

MIT
