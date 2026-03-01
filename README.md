# PAI Mobile Integration

A Telegram bot that bridges your mobile phone to [Claude Code](https://docs.anthropic.com/en/docs/claude-code), giving you AI assistant access from anywhere. Built for the [PAI](https://github.com/danielmiessler/fabric) community.

## What it does

Send a message on Telegram, get a Claude Code response back. Two modes:

- **Lite** — Fast, stateless responses for simple questions (weather, lookups, greetings)
- **Full** — Full Claude Code with tools, file access, and session continuity for complex work

The bot auto-routes messages to the right mode using keyword heuristics. Override anytime with `/lite` or `/full`.

## Features

- **Dual-mode routing** — keyword classifier routes simple vs complex tasks automatically
- **Session continuity** — full mode maintains conversation context via `--resume`
- **Message queue** — messages sent while processing get queued and handled in order
- **Long task notifications** — "this will take a few minutes" ping after 15 seconds
- **HTML formatting** — markdown from Claude is converted to Telegram-native HTML
- **Cancellation** — `/cancel` kills the current task and clears the queue
- **Multi-session** — create, switch, and manage multiple conversation sessions
- **Auto-start** — launchd service for macOS (starts on boot, auto-restarts on crash)

## Prerequisites

- **Claude Code CLI** installed and authenticated (`claude` command available)
- **Claude Max plan** (the bot uses `claude -p` which bills to your Max subscription, not API credits)
- **Node.js 18+** and npm
- A **Telegram bot token** (get one from [@BotFather](https://t.me/BotFather))
- Your **Telegram chat ID** (send `/start` to [@userinfobot](https://t.me/userinfobot))

## Setup

```bash
# Clone the repo
git clone https://github.com/youruser/pai-mobile.git
cd pai-mobile

# Install dependencies
npm install

# Configure
cp .env.example .env
# Edit .env with your bot token, chat ID, and preferred bot name

# Run in dev mode
npm run dev

# Or install as a service (macOS)
./manage.sh install
./manage.sh start
```

## Configuration

All configuration lives in `.env`:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BOT_NAME` | No | `PAI Mobile` | Your bot's display name (used in prompts) |
| `USER_NAME` | No | `User` | Your name (used in prompts) |
| `TELEGRAM_BOT_TOKEN` | **Yes** | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | **Yes** | — | Comma-separated authorized chat IDs |
| `LITE_MODEL` | No | `sonnet` | Claude model for lite mode |
| `FULL_MODEL` | No | `sonnet` | Claude model for full mode |
| `PERMISSION_MODE` | No | `bypassPermissions` | Claude Code permission mode |

## Commands

| Command | Description |
|---------|-------------|
| `/new [name]` | Create a new conversation session |
| `/sessions` | List all sessions |
| `/switch <id>` | Switch to a different session |
| `/lite` | Lock current session to lite mode |
| `/full` | Lock current session to full mode |
| `/auto` | Restore auto-detect mode |
| `/cancel` | Cancel current task and clear queue |
| `/status` | Show current session info |
| `/help` | List all commands |

## Architecture

```
Telegram → index.ts (polling) → classifier.ts (keyword heuristic)
                                   ├── lite.ts → claude -p (stateless)
                                   └── full.ts → claude -p (session resume)
                                        ↓
                              claude-runner.ts (shared CLI spawner)
                                        ↓
                              sessions.ts (state persistence)
```

- **All inference goes through `claude -p`** — no direct API calls. Uses your Claude Max subscription.
- **Lite mode is stateless** — each message gets a fresh Claude context. Prevents context poisoning from prior conversations.
- **Full mode resumes sessions** — maintains conversation continuity for multi-turn work.
- **Message queue** — prevents message loss when the bot is busy processing.

## Customization

### System Prompts

Edit `prompts/lite-system.md` and `prompts/full-system.md` to customize your bot's personality and behavior. Use `{{BOT_NAME}}` and `{{USER_NAME}}` placeholders — they're replaced at runtime from your `.env` config.

### Classifier

Edit `src/classifier.ts` to tune which messages route to lite vs full mode. The default uses keyword patterns — add your own patterns for your use case.

## Service Management (macOS)

```bash
./manage.sh install   # Generate and install launchd plist
./manage.sh start     # Start the service
./manage.sh stop      # Stop the service
./manage.sh restart   # Restart the service
./manage.sh status    # Check if running
./manage.sh logs      # Tail the log file
./manage.sh uninstall # Remove the service
./manage.sh dev       # Run in dev mode (auto-restart on file changes)
```

## Security Notes

- Only chat IDs listed in `TELEGRAM_CHAT_ID` can interact with the bot
- The bot runs `claude -p` with `bypassPermissions` — authentication is handled at the Telegram level
- The full mode system prompt includes self-modification protection to prevent Claude from accidentally restarting the bot
- Never commit your `.env` file (it's in `.gitignore`)

## License

MIT
