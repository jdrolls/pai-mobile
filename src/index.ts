import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import { log } from './logger.js';
import { deleteWebhook, formatForTelegram, getUpdates, sendMessage, sendTyping, type TelegramUpdate } from './telegram.js';
import { classifyMessage, type Mode } from './classifier.js';
import { handleLite } from './lite.js';
import { handleFull } from './full.js';
import {
  loadSessions, getOrCreateSession, createSession,
  listSessions, switchSession, setModeOverride,
  updateSession, autoNameSession, type Session,
} from './sessions.js';

// ─── State ──────────────────────────────────────────────────────

let lastUpdateId: number | undefined;
const processingChats = new Set<string>();
const messageQueues = new Map<string, Array<{ text: string; chatId: number }>>();
const activeControllers = new Map<string, AbortController>();

// ─── Queue Persistence ──────────────────────────────────────────

const QUEUE_PATH = join(config.dataDir, 'queue.json');

type QueueStore = Record<string, Array<{ text: string; chatId: number }>>;

function loadQueue(): void {
  if (existsSync(QUEUE_PATH)) {
    try {
      const data: QueueStore = JSON.parse(readFileSync(QUEUE_PATH, 'utf-8'));
      for (const [chatStr, items] of Object.entries(data)) {
        if (items.length > 0) {
          messageQueues.set(chatStr, items);
          log('info', `Restored ${items.length} queued message(s) for chat ${chatStr}`);
        }
      }
    } catch (e) {
      log('warn', `Failed to parse queue file, starting fresh: ${e}`);
    }
  }
}

function saveQueue(): void {
  const data: QueueStore = {};
  for (const [chatStr, items] of messageQueues) {
    if (items.length > 0) data[chatStr] = items;
  }
  const tmpPath = QUEUE_PATH + '.tmp';
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, QUEUE_PATH); // Atomic on POSIX
  } catch (e) {
    log('error', `Failed to save queue: ${e}`);
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

// ─── Rate Limiting ──────────────────────────────────────────────

const messageTimestamps = new Map<string, number[]>();
let activeClaude = 0;

function isRateLimited(chatStr: string): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const timestamps = messageTimestamps.get(chatStr) ?? [];
  // Remove timestamps outside the window
  const recent = timestamps.filter(t => now - t < windowMs);
  messageTimestamps.set(chatStr, recent);
  return recent.length >= config.maxMessagesPerMinute;
}

function recordMessage(chatStr: string): void {
  const timestamps = messageTimestamps.get(chatStr) ?? [];
  timestamps.push(Date.now());
  messageTimestamps.set(chatStr, timestamps);
}

// ─── Command Handling ───────────────────────────────────────────

async function handleCommand(chatId: number, command: string, args: string): Promise<string | null> {
  const chatStr = String(chatId);

  switch (command) {
    case '/new': {
      const name = args.trim() || undefined;
      const session = createSession(chatStr, name);
      return `Created new session: *${session.name}* (${session.id})\nMode: auto-detect`;
    }

    case '/sessions': {
      const sessions = listSessions();
      if (sessions.length === 0) return 'No sessions yet. Send a message to start one.';
      const active = getOrCreateSession(chatStr);
      const lines = sessions.slice(0, 10).map(s => {
        const marker = s.id === active.id ? ' \u2190 active' : '';
        const mode = s.modeOverride ?? 'auto';
        const age = formatAge(s.lastActive);
        return `${s.id === active.id ? '\u25b8' : '\u00b7'} *${s.name}* [${mode}] (${s.messageCount} msgs, ${age})${marker}`;
      });
      return `Sessions:\n${lines.join('\n')}\n\nUse /switch <id> to change.`;
    }

    case '/switch': {
      const targetId = args.trim();
      if (!targetId) {
        return 'Usage: /switch <session_id>\nUse /sessions to see available sessions.';
      }
      const session = switchSession(chatStr, targetId);
      if (!session) return `Session not found: ${targetId}`;
      return `Switched to: *${session.name}* (${session.id})`;
    }

    case '/lite': {
      const session = getOrCreateSession(chatStr);
      setModeOverride(session.id, 'lite');
      return 'Mode locked to LITE for this session. Use /auto to restore auto-detection.';
    }

    case '/full': {
      const session = getOrCreateSession(chatStr);
      setModeOverride(session.id, 'full');
      return 'Mode locked to FULL for this session. Use /auto to restore auto-detection.';
    }

    case '/auto': {
      const session = getOrCreateSession(chatStr);
      setModeOverride(session.id, undefined);
      return 'Mode restored to auto-detect for this session.';
    }

    case '/status': {
      const session = getOrCreateSession(chatStr);
      const mode = session.modeOverride ?? 'auto';
      return [
        `*Session:* ${session.name} (${session.id})`,
        `*Mode:* ${mode}`,
        `*Messages:* ${session.messageCount}`,
        `*Claude Session:* ${session.claudeSessionId ?? 'none'}`,
        `*Created:* ${new Date(session.createdAt).toLocaleDateString()}`,
        `*Last Active:* ${formatAge(session.lastActive)}`,
      ].join('\n');
    }

    case '/cancel': {
      const ctrl = activeControllers.get(chatStr);
      if (ctrl) {
        ctrl.abort();
        processingChats.delete(chatStr);
        const queueSize = messageQueues.get(chatStr)?.length ?? 0;
        messageQueues.delete(chatStr);
        saveQueue();
        activeControllers.delete(chatStr);
        return `Cancelled current task${queueSize > 0 ? ` and cleared ${queueSize} queued message(s)` : ''}.`;
      }
      return 'Nothing to cancel \u2014 no task in progress.';
    }

    case '/help': {
      return [
        `*${config.botName} Commands:*`,
        '',
        '/new [name] \u2014 Create a new session',
        '/sessions \u2014 List all sessions',
        '/switch <id> \u2014 Switch to a session',
        '/lite \u2014 Lock to lite mode (fast, simple tasks)',
        '/full \u2014 Lock to full mode (Claude Code, complex work)',
        '/auto \u2014 Restore auto-detect mode',
        '/cancel \u2014 Cancel current task and clear queue',
        '/status \u2014 Current session info',
        '/help \u2014 This message',
        '',
        '*Modes:*',
        '\u00b7 LITE \u2014 Direct inference, fast, for simple tasks',
        '\u00b7 FULL \u2014 Claude Code with tools, for complex work',
        '\u00b7 Auto-detect routes based on your message',
      ].join('\n');
    }

    default:
      return null; // Not a recognized command
  }
}

// ─── Message Processing ─────────────────────────────────────────

async function processMessage(chatId: number, text: string): Promise<void> {
  const chatStr = String(chatId);

  // Auth check
  if (!config.authorizedChatIds.includes(chatStr)) {
    log('warn', `Unauthorized message from chat ${chatStr}`);
    return; // Silent drop
  }

  // Check for commands
  if (text.startsWith('/')) {
    const spaceIdx = text.indexOf(' ');
    const command = spaceIdx > 0 ? text.slice(0, spaceIdx).toLowerCase() : text.toLowerCase();
    const args = spaceIdx > 0 ? text.slice(spaceIdx + 1) : '';

    // Strip @botname suffix from command (e.g., /help@MyBot)
    const cleanCommand = command.split('@')[0];

    const response = await handleCommand(chatId, cleanCommand, args);
    if (response) {
      await sendMessage(chatId, response, 'Markdown');
      return;
    }
    // If not a recognized command, treat as a regular message
  }

  // Rate limit check
  if (isRateLimited(chatStr)) {
    log('warn', `Rate limited chat ${chatStr}`);
    await sendMessage(chatId, 'Slow down \u2014 too many messages. Try again in a minute.');
    return;
  }
  recordMessage(chatStr);

  // Check if already processing for this chat
  if (processingChats.has(chatStr)) {
    // Queue the message
    if (!messageQueues.has(chatStr)) messageQueues.set(chatStr, []);
    messageQueues.get(chatStr)!.push({ text, chatId });
    saveQueue();
    await sendMessage(chatId, '\ud83d\udcac Queued \u2014 I\'ll get to this when my current task finishes.');
    log('info', `Queued message for chat ${chatStr}`);
    return;
  }

  processingChats.add(chatStr);
  const controller = new AbortController();
  activeControllers.set(chatStr, controller);

  try {
    // Start typing indicator
    const typingInterval = setInterval(() => sendTyping(chatId), config.typingIntervalMs);
    await sendTyping(chatId);

    // Ping user if processing takes longer than threshold
    const longTaskTimer = setTimeout(() => {
      sendMessage(chatId, '\u23f3 This one\'s taking a few minutes \u2014 I\'ll ping you when it\'s done.').catch(() => {});
    }, config.longTaskThresholdMs);

    try {
      // Concurrent Claude process limit
      if (activeClaude >= config.maxConcurrentClaude) {
        log('warn', `Concurrent Claude limit reached (${activeClaude}/${config.maxConcurrentClaude})`);
        if (!messageQueues.has(chatStr)) messageQueues.set(chatStr, []);
        messageQueues.get(chatStr)!.push({ text, chatId });
        saveQueue();
        await sendMessage(chatId, '\ud83d\udcac Queued \u2014 processing limit reached, I\'ll get to this shortly.');
        processingChats.delete(chatStr);
        activeControllers.delete(chatStr);
        return;
      }
      activeClaude++;

      const session = getOrCreateSession(chatStr);

      // Auto-name session from first message
      autoNameSession(session.id, text);

      // Determine mode
      let mode: Mode;
      if (session.modeOverride) {
        mode = session.modeOverride;
        log('info', `Using mode override: ${mode}`);
      } else {
        mode = classifyMessage(text); // Synchronous — instant keyword heuristic
      }

      // Process based on mode
      // Lite = stateless (no session resume), Full = session continuity
      let responseText: string;

      if (mode === 'lite') {
        const result = await handleLite(text, session.id, session.claudeSessionId, controller.signal);
        responseText = result.text;
      } else {
        const result = await handleFull(text, session.id, session.claudeSessionId, controller.signal);
        responseText = result.text;
      }

      // Update session
      updateSession(session.id, { messageCount: session.messageCount + 1 });

      // Send response with mode indicator
      const modeLabel = mode === 'lite' ? '\ud83d\udca1' : '\ud83d\udd27';
      await sendMessage(chatId, `${modeLabel} ${formatForTelegram(responseText)}`, 'HTML');
    } finally {
      clearInterval(typingInterval);
      clearTimeout(longTaskTimer);
    }
  } catch (e) {
    log('error', `Error processing message: ${e}`);
    await sendMessage(chatId, `Something went wrong: ${String(e).slice(0, 200)}`);
  } finally {
    activeClaude = Math.max(0, activeClaude - 1);
    processingChats.delete(chatStr);
    activeControllers.delete(chatStr);

    // Drain message queue
    const queue = messageQueues.get(chatStr);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) messageQueues.delete(chatStr);
      saveQueue();
      log('info', `Draining queue for chat ${chatStr}, ${queue?.length ?? 0} remaining`);
      // Process next message (recursive but not stack-deep due to async)
      await processMessage(next.chatId, next.text);
    }
  }
}

// ─── Polling Loop ───────────────────────────────────────────────

async function pollLoop(): Promise<void> {
  log('info', 'Starting polling loop...');

  while (true) {
    try {
      const updates = await getUpdates(lastUpdateId);

      for (const update of updates) {
        lastUpdateId = update.update_id + 1;

        if (update.message?.text) {
          // Fire and forget — don't block polling on processing
          processMessage(update.message.chat.id, update.message.text).catch(e => {
            log('error', `Unhandled error in processMessage: ${e}`);
          });
        }
      }
    } catch (e) {
      const msg = String(e);
      if (msg.includes('abort') || msg.includes('timeout')) {
        // Normal poll timeout, continue
        continue;
      }
      log('error', `Polling error: ${msg}`);
      // Back off on errors
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Startup ────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`
\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
\u2551  PAI Mobile Integration                  \u2551
\u2551  Telegram \u2192 Claude Code Bridge              \u2551
\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563
\u2551  Bot: ${(config.botName + '                    ').slice(0, 20)}                \u2551
\u2551  Lite: ${(config.liteModel + '                   ').slice(0, 19)}                \u2551
\u2551  Full: ${(config.fullModel + '                   ').slice(0, 19)}                \u2551
\u2551  Auth: ${String(config.authorizedChatIds.length) + ' chat(s)              '.slice(0, 19)}                \u2551
\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d
`);

  // Load session state and persisted queue
  loadSessions();
  loadQueue();

  // Drain any queued messages from previous crash
  if (messageQueues.size > 0) {
    // Snapshot and clear — processMessage handles its own queue logic
    const snapshot = new Map(messageQueues);
    messageQueues.clear();
    saveQueue();
    for (const [chatStr, items] of snapshot) {
      log('info', `Resuming ${items.length} queued message(s) for chat ${chatStr} from previous session`);
      for (const item of items) {
        processMessage(item.chatId, item.text).catch(e => {
          log('error', `Failed to resume queued message: ${e}`);
        });
      }
    }
  }

  // Clear any existing webhook (prevents polling conflict)
  try {
    await deleteWebhook();
    log('info', 'Webhook cleared');
  } catch (e) {
    log('warn', `Failed to clear webhook: ${e}`);
  }

  // Start polling
  await pollLoop();
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  log('info', 'Received SIGINT, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('info', 'Received SIGTERM, shutting down...');
  process.exit(0);
});

main().catch(e => {
  log('error', `Fatal error: ${e}`);
  process.exit(1);
});
