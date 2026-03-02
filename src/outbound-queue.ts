/**
 * Outbound message queue — single async sender for all Telegram deliveries.
 * Prevents race conditions, respects rate limits, enables message bundling.
 */
import { sendMessage, formatForTelegram } from './telegram.js';
import { log } from './logger.js';

export interface OutboundMessage {
  chatId: number | string;
  text: string;
  source: 'user' | 'cron' | 'heartbeat';
  jobName?: string;
  timestamp: number;
  parseMode?: string;
}

const SOURCE_PREFIX: Record<string, string> = {
  heartbeat: '\u{1F493}',  // heart
  cron: '\u{23F0}',        // alarm clock
  user: '',
};

const BUNDLE_WINDOW_MS = 15_000; // 15s window to bundle same-source messages
const SEND_SPACING_MS = 1_000;   // 1s between sends (Telegram rate limit)
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

let queue: OutboundMessage[] = [];
let running = false;
let drainTimer: ReturnType<typeof setTimeout> | null = null;

export function enqueueOutbound(msg: OutboundMessage): void {
  queue.push(msg);
  scheduleDrain();
}

function scheduleDrain(): void {
  if (drainTimer) return;
  // Small delay to allow bundling
  drainTimer = setTimeout(() => {
    drainTimer = null;
    drainQueue().catch(e => log('error', `Outbound drain error: ${e}`));
  }, 500);
}

async function drainQueue(): Promise<void> {
  if (running || queue.length === 0) return;
  running = true;

  try {
    while (queue.length > 0) {
      // Group by source + chatId for bundling
      const first = queue[0];
      const cutoff = first.timestamp + BUNDLE_WINDOW_MS;
      const now = Date.now();

      // If the first message is recent, wait a bit for bundling
      if (now < cutoff && queue.length === 1 && first.source !== 'user') {
        // Wait for potential bundle partners, but don't wait too long
        await sleep(Math.min(cutoff - now, 3000));
      }

      // Collect messages that can be bundled
      const batch: OutboundMessage[] = [];
      const remaining: OutboundMessage[] = [];

      for (const msg of queue) {
        if (
          msg.source === first.source &&
          msg.chatId === first.chatId &&
          msg.source !== 'user' &&
          batch.length < 5
        ) {
          batch.push(msg);
        } else {
          remaining.push(msg);
        }
      }

      // If no batch candidates, just send the first message
      if (batch.length === 0) {
        batch.push(queue.shift()!);
        queue = remaining;
      } else {
        queue = remaining;
      }

      // Send (bundled or single)
      await sendBatch(batch);
      await sleep(SEND_SPACING_MS);
    }
  } finally {
    running = false;
  }
}

async function sendBatch(batch: OutboundMessage[]): Promise<void> {
  if (batch.length === 0) return;

  const first = batch[0];
  const prefix = SOURCE_PREFIX[first.source] || '';

  let text: string;
  let parseMode = first.parseMode || 'HTML';

  if (batch.length === 1) {
    // Single message
    const formatted = first.source === 'user' ? first.text : formatForTelegram(first.text);
    text = prefix ? `${prefix} ${formatted}` : formatted;
    parseMode = first.parseMode || (first.source === 'user' ? 'HTML' : 'HTML');
  } else {
    // Bundled message
    const lines = batch.map(m => {
      const name = m.jobName ? `<b>${escapeHtml(m.jobName)}</b>` : 'task';
      const summary = m.text.slice(0, 300).replace(/\n/g, ' ');
      return `\u{2022} ${name}: ${escapeHtml(summary)}`;
    });
    text = `${prefix} ${batch.length} scheduled tasks:\n${lines.join('\n')}`;
  }

  // Retry loop
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await sendMessage(first.chatId, text, parseMode);
      return;
    } catch (e) {
      log('warn', `Outbound send failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${e}`);
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }
  log('error', `Failed to send outbound message after ${MAX_RETRIES} attempts, dropping`);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function stopOutboundQueue(): void {
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
}
