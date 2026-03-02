import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, unlink } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import { log } from './logger.js';
import { deleteWebhook, downloadTelegramImage, formatForTelegram, getUpdates, registerBotCommands, sendMessage, sendTyping, type BotCommand, type TelegramUpdate } from './telegram.js';
import { discoverSkills, type DiscoveredSkill } from './skills.js';
import { classifyMessage, type Mode } from './classifier.js';
import { handleLite } from './lite.js';
import { handleFull } from './full.js';
import {
  loadSessions, getOrCreateSession, createSession,
  listSessions, switchSession, setModeOverride,
  updateSession, autoNameSession, type Session,
} from './sessions.js';
import { startHeartbeat, stopHeartbeat, pauseHeartbeat, resumeHeartbeat, getHeartbeatStatus } from './heartbeat.js';
import { startCron, stopCron, pauseCron, resumeCron, addJob, removeJob, toggleJob, listJobs, runJobNow, type CronJob } from './cron.js';
import { stopOutboundQueue } from './outbound-queue.js';
import { ensureTranscriptsDir, appendTranscript } from './transcript.js';
import { ensureMemoryDirs, initMemoryIfNeeded, appendDailyLog } from './memory.js';

// --- Helpers ----------------------------------------------------------------

function tryDeleteFile(path: string): void {
  unlink(path, (err) => {
    if (err && err.code !== 'ENOENT') log('warn', `Failed to delete temp file ${path}: ${err.message}`);
  });
}

/**
 * Strip PAI output formatting from Claude's response.
 * Claude picks up PAI format rules from ~/.claude/CLAUDE.md (═══ PAI headers,
 * 🗒️ TASK, 📃 CONTENT, 🔧 CHANGE, ✅ VERIFY, 🗣️ lines).
 * Telegram users just want the actual content.
 */
function stripPaiFormatting(text: string): string {
  if (!text.includes('═══') && !text.includes('🗒️') && !text.includes(`🗣️ ${config.botName}:`)) return text;

  const lines = text.split('\n');
  const kept: string[] = [];
  let skipSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (!skipSection) kept.push('');
      continue;
    }

    // PAI header lines (═══ PAI ═══, ════ PAI | NATIVE MODE ═══, etc.)
    if (/═{3,}/.test(trimmed)) { skipSection = false; continue; }

    // Metadata lines to skip
    if (/^🗒️\s*TASK:/i.test(trimmed)) { skipSection = false; continue; }
    if (/^🔄\s*ITERATION/i.test(trimmed)) { skipSection = false; continue; }

    // Sections to skip including their sub-bullets
    if (/^🔧\s*CHANGE/i.test(trimmed)) { skipSection = true; continue; }
    if (/^✅\s*VERIFY/i.test(trimmed)) { skipSection = true; continue; }
    if (/^📋\s*SUMMARY/i.test(trimmed)) { skipSection = true; continue; }

    // CONTENT: — extract text after prefix
    const contentMatch = trimmed.match(/^📃\s*CONTENT:\s*(.*)/i);
    if (contentMatch) {
      skipSection = false;
      if (contentMatch[1]) kept.push(contentMatch[1]);
      continue;
    }

    // Bot name summary line — use as fallback if no other content collected yet
    const botNamePattern = new RegExp(`^🗣️\\s*${config.botName}:\\s*(.*)`, 'i');
    const doraMatch = trimmed.match(botNamePattern) || trimmed.match(/^🗣️\s*\w+:\s*(.*)/i);
    if (doraMatch) {
      skipSection = false;
      if (kept.filter(l => l.trim()).length === 0 && doraMatch[1]) {
        kept.push(doraMatch[1]);
      }
      continue;
    }

    // Skip sub-bullets in CHANGE/VERIFY/SUMMARY sections
    if (skipSection && /^[-•]/.test(trimmed)) continue;

    // Regular content — keep
    skipSection = false;
    kept.push(line);
  }

  const result = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return result || text;
}

// --- Queue Persistence ------------------------------------------------------

const QUEUE_PATH = join(config.dataDir, 'queue.json');

function loadQueue(): void {
  if (existsSync(QUEUE_PATH)) {
    try {
      const data = JSON.parse(readFileSync(QUEUE_PATH, 'utf-8'));
      for (const [chatStr, items] of Object.entries(data)) {
        if (Array.isArray(items) && items.length > 0) {
          messageQueues.set(chatStr, items as Array<{ text: string; chatId: number; imagePath?: string }>);
        }
      }
      log('info', `Loaded ${messageQueues.size} queued chat(s) from disk`);
    } catch (e) {
      log('warn', `Failed to parse queue file, starting fresh: ${e}`);
    }
  }
}

function saveQueue(): void {
  const obj: Record<string, Array<{ text: string; chatId: number; imagePath?: string }>> = {};
  for (const [chatStr, items] of messageQueues) {
    if (items.length > 0) obj[chatStr] = items;
  }
  const tmpPath = QUEUE_PATH + '.tmp';
  try {
    writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
    renameSync(tmpPath, QUEUE_PATH);
  } catch (e) {
    log('error', `Failed to save queue: ${e}`);
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

// --- Rate Limiting ----------------------------------------------------------

const messageTimestamps = new Map<string, number[]>();
let activeClaude = 0;

function isRateLimited(chatStr: string): boolean {
  const now = Date.now();
  const timestamps = messageTimestamps.get(chatStr) ?? [];
  const recent = timestamps.filter(t => now - t < 60_000);
  messageTimestamps.set(chatStr, recent);
  return recent.length >= config.maxMessagesPerMinute;
}

function recordMessage(chatStr: string): void {
  const timestamps = messageTimestamps.get(chatStr) ?? [];
  timestamps.push(Date.now());
  messageTimestamps.set(chatStr, timestamps);
}

// --- State ------------------------------------------------------------------

const LAST_UPDATE_PATH = join(config.dataDir, 'last-update-id');
let lastUpdateId: number | undefined;
const processingChats = new Set<string>();
const messageQueues = new Map<string, Array<{ text: string; chatId: number; imagePath?: string }>>();
const activeControllers = new Map<string, AbortController>();
let proactivePaused = false;

// --- Skill Discovery ---------------------------------------------------------
const builtinCommands = new Set([
  'new', 'sessions', 'switch', 'lite', 'full', 'auto',
  'cancel', 'status', 'heartbeat', 'pause', 'resume',
  'cron', 'help', 'start',
]);
let skillMap = new Map<string, DiscoveredSkill>();

function loadLastUpdateId(): void {
  if (existsSync(LAST_UPDATE_PATH)) {
    try {
      const val = parseInt(readFileSync(LAST_UPDATE_PATH, 'utf-8').trim(), 10);
      if (!isNaN(val)) lastUpdateId = val;
    } catch { /* start fresh */ }
  }
}

function saveLastUpdateId(id: number): void {
  try { writeFileSync(LAST_UPDATE_PATH, String(id)); } catch { /* best effort */ }
}

/** Returns true if any user message is currently being processed */
export function isUserProcessing(): boolean {
  return processingChats.size > 0;
}

// --- Command Handling -------------------------------------------------------

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

    case '/heartbeat': {
      const hb = getHeartbeatStatus();
      const nextIn = hb.nextRunEstimate > Date.now()
        ? `${Math.round((hb.nextRunEstimate - Date.now()) / 60_000)}m`
        : 'now';
      return [
        '*Heartbeat Status:*',
        `Enabled: ${hb.enabled}`,
        `Paused: ${hb.paused || proactivePaused}`,
        `Last run: ${hb.lastRunAt ? formatAge(hb.lastRunAt) : 'never'}`,
        `Next: ~${nextIn}`,
        `Failures: ${hb.consecutiveFailures}`,
        `Circuit breaker: ${hb.circuitBreakerActive ? 'ACTIVE' : 'off'}`,
      ].join('\n');
    }

    case '/pause': {
      proactivePaused = true;
      pauseHeartbeat();
      pauseCron();
      return 'All proactive behavior paused (heartbeat + cron). Use /resume to restart.';
    }

    case '/resume': {
      proactivePaused = false;
      resumeHeartbeat();
      resumeCron();
      return 'Proactive behavior resumed (heartbeat + cron).';
    }

    case '/cron': {
      const subCmd = args.trim().split(/\s+/);
      const action = subCmd[0]?.toLowerCase();

      if (!action || action === 'list') {
        const jobs = listJobs();
        if (jobs.length === 0) return 'No cron jobs. Use /cron add "name" "schedule" "prompt" to create one.';
        const lines = jobs.map(j => {
          const status = j.enabled ? '\u2705' : '\u23f8';
          const lastRun = j.state.lastRunAtMs ? formatAge(j.state.lastRunAtMs) : 'never';
          return `${status} *${j.name}* (${j.id})\n   ${j.schedule.kind}: ${j.schedule.expr}\n   Last: ${lastRun} | Errors: ${j.state.consecutiveErrors}`;
        });
        return `*Cron Jobs (${jobs.length}):*\n${lines.join('\n\n')}`;
      }

      if (action === 'add') {
        // /cron add "name" "schedule" "prompt"
        const parts = args.slice(3).trim().match(/"([^"]+)"/g);
        if (!parts || parts.length < 3) {
          return 'Usage: /cron add "job name" "schedule" "prompt"\nSchedule examples: "daily 7am", "every 2h", "weekdays 9am"';
        }
        const [name, schedule, message] = parts.map(p => p.replace(/"/g, ''));
        const result = addJob(name, schedule, message);
        if ('error' in result) return `Error: ${result.error}`;
        return `Created cron job: *${result.name}* (${result.id})\nSchedule: ${result.schedule.expr}`;
      }

      if (action === 'remove' || action === 'delete') {
        const id = subCmd[1];
        if (!id) return 'Usage: /cron remove <id>';
        return removeJob(id) ? `Removed job ${id}` : `Job not found: ${id}`;
      }

      if (action === 'toggle') {
        const id = subCmd[1];
        if (!id) return 'Usage: /cron toggle <id>';
        const job = toggleJob(id);
        if (!job) return `Job not found: ${id}`;
        return `Job *${job.name}* is now ${job.enabled ? 'enabled' : 'disabled'}`;
      }

      if (action === 'run') {
        const id = subCmd[1];
        if (!id) return 'Usage: /cron run <id>';
        const result = await runJobNow(id);
        return result;
      }

      return 'Usage: /cron [list|add|remove|toggle|run]\n/cron add "name" "schedule" "prompt"';
    }

    case '/help': {
      const lines = [
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
        '',
        '*Proactive:*',
        '/heartbeat \u2014 Heartbeat status',
        '/cron \u2014 Manage cron jobs',
        '/pause \u2014 Pause all proactive behavior',
        '/resume \u2014 Resume proactive behavior',
        '',
        '/help \u2014 This message',
      ];

      if (skillMap.size > 0) {
        lines.push('', `*PAI Skills (${skillMap.size}):*`);
        const sorted = [...skillMap.values()].sort((a, b) => a.command.localeCompare(b.command));
        for (const s of sorted.slice(0, 20)) {
          const desc = s.description.length > 60 ? s.description.slice(0, 57) + '...' : s.description;
          lines.push(`/${s.command} \u2014 ${desc}`);
        }
        if (sorted.length > 20) {
          lines.push(`...and ${sorted.length - 20} more`);
        }
      }

      return lines.join('\n');
    }

    default:
      return null; // Not a recognized command
  }
}

// --- Message Processing -----------------------------------------------------

async function processMessage(chatId: number, text: string, imagePath?: string): Promise<void> {
  const chatStr = String(chatId);

  // Auth check (applies to all message types including images)
  if (!config.authorizedChatIds.includes(chatStr)) {
    log('warn', `Unauthorized message from chat ${chatStr}`);
    if (imagePath) tryDeleteFile(imagePath);
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

    // Check if it's a skill command (e.g., /research quantum computing)
    const skillCmd = cleanCommand.slice(1); // remove leading /
    const skill = skillMap.get(skillCmd);
    if (skill) {
      // Rewrite as a natural language request for Claude with skill routing
      const skillArgs = args.trim();
      text = skillArgs
        ? `Use the ${skill.dirName} skill: ${skillArgs}`
        : `Use the ${skill.dirName} skill`;
      log('info', `Skill command /${skillCmd} → "${text}"`);
      // Fall through to normal message processing below
    }
    // If not a recognized command or skill, treat as a regular message
  }

  // Rate limit check
  if (isRateLimited(chatStr)) {
    await sendMessage(chatId, 'Slow down \u2014 too many messages. Try again in a minute.');
    log('warn', `Rate limited chat ${chatStr}`);
    return;
  }
  recordMessage(chatStr);

  // Check if already processing for this chat
  if (processingChats.has(chatStr)) {
    // Queue the message
    if (!messageQueues.has(chatStr)) messageQueues.set(chatStr, []);
    messageQueues.get(chatStr)!.push({ text, chatId, imagePath });
    saveQueue();
    await sendMessage(chatId, '\ud83d\udcac Queued \u2014 I\'ll get to this when my current task finishes.');
    log('info', `Queued message for chat ${chatStr}`);
    return;
  }

  processingChats.add(chatStr);
  const controller = new AbortController();
  activeControllers.set(chatStr, controller);

  try {
    // Check concurrent Claude limit
    if (activeClaude >= config.maxConcurrentClaude) {
      if (!messageQueues.has(chatStr)) messageQueues.set(chatStr, []);
      messageQueues.get(chatStr)!.push({ text, chatId, imagePath });
      saveQueue();
      processingChats.delete(chatStr);
      activeControllers.delete(chatStr);
      await sendMessage(chatId, '\ud83d\udcac Queued \u2014 too many tasks running. I\'ll get to this shortly.');
      log('info', `Concurrent limit reached, queued message for chat ${chatStr}`);
      return;
    }
    activeClaude++;

    // Start typing indicator
    const typingInterval = setInterval(() => sendTyping(chatId), config.typingIntervalMs);
    await sendTyping(chatId);

    // Ping user if processing takes longer than threshold
    const longTaskTimer = setTimeout(() => {
      sendMessage(chatId, '\u23f3 This one\'s taking a few minutes \u2014 I\'ll ping you when it\'s done.').catch(() => {});
    }, config.longTaskThresholdMs);

    try {
      const session = getOrCreateSession(chatStr);

      // Auto-name session from first message
      autoNameSession(session.id, text);

      // Determine mode
      let mode: Mode;
      if (session.modeOverride) {
        mode = session.modeOverride;
        log('info', `Using mode override: ${mode}`);
      } else {
        // Classify for logging, but default to full for context continuity.
        // Both lite and full use sonnet — zero cost difference.
        // Conversational messages ("Hi", "Yes", "What were we talking about?")
        // never match full patterns, so the old approach left them stateless.
        // Now: ALL sessions auto-lock to full. Users can /lite to opt out.
        const classified = classifyMessage(text);
        mode = 'full';
        setModeOverride(session.id, 'full');
        log('info', `Auto-locked session ${session.id} to full (classified: ${classified}, locked for context continuity)`);
      }

      // Process based on mode
      // Lite = stateless (no session resume), Full = session continuity
      let responseText: string;

      if (mode === 'lite') {
        const result = await handleLite(text, session.id, session.claudeSessionId, controller.signal);
        responseText = result.text;
      } else {
        const result = await handleFull(
          text, session.id, session.claudeSessionId, controller.signal,
          { injectTranscript: session.contextRecovery },
        );
        responseText = result.text;

        // -- Transcript recording (full mode only) --
        appendTranscript(session.id, 'user', text);
        appendTranscript(session.id, 'assistant', responseText);

        // -- Resume failure detection --
        if (result.resumeFailed) {
          // Next call will inject transcript as context recovery
          updateSession(session.id, { contextRecovery: true } as Partial<Session>);
          log('warn', `Session ${session.id} marked for context recovery`);
        } else if (session.contextRecovery) {
          // Recovery was applied this turn, clear the flag
          updateSession(session.id, { contextRecovery: false } as Partial<Session>);
          log('info', `Context recovery cleared for session ${session.id}`);
        }

        // -- Daily log (async, best-effort) --
        try {
          appendDailyLog(session.name, text, responseText);
        } catch { /* non-critical */ }
      }

      // Update session
      updateSession(session.id, { messageCount: session.messageCount + 1 });

      // Strip PAI formatting and send clean response
      responseText = stripPaiFormatting(responseText);
      await sendMessage(chatId, formatForTelegram(responseText), 'HTML');
    } finally {
      clearInterval(typingInterval);
      clearTimeout(longTaskTimer);
    }
  } catch (e) {
    log('error', `Error processing message: ${e}`);
    await sendMessage(chatId, `Something went wrong: ${String(e).slice(0, 200)}`);
  } finally {
    // Clean up temp image file whether processing succeeded or failed
    if (imagePath) tryDeleteFile(imagePath);

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
      await processMessage(next.chatId, next.text, next.imagePath);
    }
  }
}

// --- Polling Loop -----------------------------------------------------------

async function pollLoop(): Promise<void> {
  log('info', 'Starting polling loop...');

  while (true) {
    try {
      const updates = await getUpdates(lastUpdateId);

      for (const update of updates) {
        lastUpdateId = update.update_id + 1;
        saveLastUpdateId(lastUpdateId);

        const msg = update.message;
        if (msg?.text) {
          // Fire and forget — don't block polling on processing
          processMessage(msg.chat.id, msg.text).catch(e => {
            log('error', `Unhandled error in processMessage: ${e}`);
          });
        } else if (msg?.photo || msg?.document) {
          // Image or document message — download and forward to Claude
          const chatId = msg.chat.id;
          const chatStr = String(chatId);

          // Auth check before doing any work
          if (!config.authorizedChatIds.includes(chatStr)) {
            log('warn', `Unauthorized image message from chat ${chatStr}`);
          } else {
            downloadTelegramImage(msg).then(result => {
              if (result === null) return; // No image found, skip silently

              if ('unsupported' in result) {
                // Non-image document (PDF, video, etc.)
                sendMessage(chatId, `I received a file (${result.unsupported}) but I can only process image files and text. Try sending the image directly or paste the text content.`).catch(() => {});
                return;
              }

              // Build message with image reference and optional caption
              const caption = msg.caption ? `\n\nCaption: ${msg.caption}` : '';
              const claudeMessage = `[IMAGE ATTACHED: ${result.path}]\n\nPlease use the Read tool to view the image at that path and respond based on what you see.${caption}`;

              processMessage(chatId, claudeMessage, result.path).catch(e => {
                log('error', `Unhandled error processing image message: ${e}`);
                tryDeleteFile(result.path);
              });
            }).catch(e => {
              log('error', `Failed to download Telegram image: ${e}`);
              sendMessage(chatId, `Failed to download your image: ${String(e).slice(0, 100)}`).catch(() => {});
            });
          }
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

// --- Helpers ----------------------------------------------------------------

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

// --- Startup ----------------------------------------------------------------

async function main(): Promise<void> {
  const hbStatus = config.heartbeat.enabled ? 'ON' : 'OFF';
  console.log(`
\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
\u2551  PAI Mobile Gateway v2.1.1                \u2551
\u2551  Telegram \u2192 Claude Code Bridge              \u2551
\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563
\u2551  Bot: ${(config.botName + '                    ').slice(0, 20)}                \u2551
\u2551  Lite: ${(config.liteModel + '                   ').slice(0, 19)}                \u2551
\u2551  Full: ${(config.fullModel + '                   ').slice(0, 19)}                \u2551
\u2551  Heartbeat: ${hbStatus.padEnd(28)}\u2551
\u2551  Auth: ${String(config.authorizedChatIds.length) + ' chat(s)              '.slice(0, 19)}                \u2551
\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d
`);

  // Load persisted state
  loadSessions();
  loadQueue();
  loadLastUpdateId();

  // Initialize transcript and memory directories
  ensureTranscriptsDir();
  ensureMemoryDirs();
  initMemoryIfNeeded();

  // Drain any queued messages from previous session
  if (messageQueues.size > 0) {
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

  // Discover PAI skills and register Telegram bot commands
  try {
    const discoveredSkills = discoverSkills();
    log('info', `Discovered ${discoveredSkills.length} PAI skills`);

    // Build skill map, excluding collisions with built-in commands
    for (const skill of discoveredSkills) {
      if (builtinCommands.has(skill.command)) {
        log('warn', `Skill "${skill.name}" collides with built-in /${skill.command}, skipping`);
        continue;
      }
      skillMap.set(skill.command, skill);
    }

    // Register all commands with Telegram
    const botCommands: BotCommand[] = [
      { command: 'new', description: 'Create a new conversation session' },
      { command: 'sessions', description: 'List all sessions' },
      { command: 'switch', description: 'Switch to a different session' },
      { command: 'lite', description: 'Lock to lite mode (fast, no tools)' },
      { command: 'full', description: 'Lock to full mode (Claude Code)' },
      { command: 'auto', description: 'Restore auto-detect mode' },
      { command: 'cancel', description: 'Cancel current task and clear queue' },
      { command: 'status', description: 'Current session info' },
      { command: 'heartbeat', description: 'Check heartbeat status' },
      { command: 'cron', description: 'Manage scheduled tasks' },
      { command: 'pause', description: 'Pause all proactive behavior' },
      { command: 'resume', description: 'Resume proactive behavior' },
      { command: 'help', description: 'Show all commands' },
    ];

    // Add skill commands (Telegram practical limit: ~50 commands total)
    const maxSkillCommands = Math.max(0, 50 - botCommands.length);
    const skillCommands = [...skillMap.values()]
      .sort((a, b) => a.command.localeCompare(b.command))
      .slice(0, maxSkillCommands)
      .map(s => ({ command: s.command, description: s.description }));

    await registerBotCommands([...botCommands, ...skillCommands]);
    log('info', `Registered ${botCommands.length + skillCommands.length} bot commands (${botCommands.length} built-in + ${skillCommands.length} skills)`);
  } catch (e) {
    log('warn', `Failed to register bot commands (non-fatal): ${e}`);
  }

  // Start proactive systems
  const primaryChatId = config.authorizedChatIds[0];
  if (primaryChatId) {
    startHeartbeat(config.heartbeat, primaryChatId, isUserProcessing);
    startCron(config.dataDir, primaryChatId, isUserProcessing);
  }

  // Start polling
  await pollLoop();
}

// Handle graceful shutdown
function shutdown(signal: string): void {
  log('info', `Received ${signal}, shutting down...`);
  stopHeartbeat();
  stopCron();
  stopOutboundQueue();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch(e => {
  log('error', `Fatal error: ${e}`);
  process.exit(1);
});
