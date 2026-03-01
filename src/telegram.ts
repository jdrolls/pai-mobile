import { config } from './config.js';

const BASE_URL = `https://api.telegram.org/bot${config.telegramToken}`;

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string };
    date: number;
    text?: string;
  };
}

export interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

async function apiCall<T>(method: string, body?: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${BASE_URL}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json() as TelegramResponse<T>;
    if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function getUpdates(offset?: number): Promise<TelegramUpdate[]> {
  const clientTimeout = (config.pollTimeoutSec + 15) * 1000;
  return apiCall<TelegramUpdate[]>('getUpdates', {
    offset,
    timeout: config.pollTimeoutSec,
    allowed_updates: ['message'],
  }, clientTimeout);
}

export async function sendMessage(chatId: number | string, text: string, parseMode?: string): Promise<void> {
  // Chunk long messages
  const chunks = chunkMessage(text);
  for (const chunk of chunks) {
    await apiCall('sendMessage', {
      chat_id: chatId,
      text: chunk,
      parse_mode: parseMode,
    });
  }
}

export async function sendTyping(chatId: number | string): Promise<void> {
  try {
    await apiCall('sendChatAction', { chat_id: chatId, action: 'typing' }, 5000);
  } catch {
    // Non-critical, ignore
  }
}

export async function deleteWebhook(): Promise<void> {
  await apiCall('deleteWebhook', {});
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert Claude markdown output to Telegram HTML.
 * Processing order matters: extract code first (protect from escaping),
 * escape HTML entities in plain text, then apply markdown conversions.
 */
export function formatForTelegram(text: string): string {
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 1. Extract fenced code blocks — protect content from markdown conversion
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = escapeHtml(code.trim());
    const tag = lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`;
    codeBlocks.push(tag);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract inline code — protect from markdown conversion
  result = result.replace(/`([^`\n]+)`/g, (_, code) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 3. Escape HTML entities in plain text (placeholders use \x00 — safe)
  result = escapeHtml(result);

  // 4. Apply markdown → HTML conversions
  // Headers
  result = result.replace(/^#{1,3} (.+)$/gm, '<b>$1</b>');
  // Bold (**text** or __text__)
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');
  // Italic (*text* or _text_) — after bold to avoid conflict
  result = result.replace(/\*([^*\n]+)\*/g, '<i>$1</i>');
  result = result.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '<i>$1</i>');
  // Links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 5. Restore code blocks and inline code
  result = result.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);
  result = result.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCodes[parseInt(i)]);

  return result;
}

function chunkMessage(text: string): string[] {
  const limit = config.telegramMsgLimit;
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try to break at newline
    let breakIdx = remaining.lastIndexOf('\n', limit);
    if (breakIdx < limit * 0.5) {
      // Try space
      breakIdx = remaining.lastIndexOf(' ', limit);
    }
    if (breakIdx < limit * 0.3) {
      // Hard break
      breakIdx = limit;
    }

    chunks.push(remaining.slice(0, breakIdx));
    remaining = remaining.slice(breakIdx).trimStart();
  }

  return chunks;
}
