import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, extname } from 'path';
import { config } from './config.js';

const BASE_URL = `https://api.telegram.org/bot${config.telegramToken}`;
const FILE_BASE_URL = `https://api.telegram.org/file/bot${config.telegramToken}`;

export interface TelegramPhoto {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string };
    date: number;
    text?: string;
    caption?: string;
    photo?: TelegramPhoto[];
    document?: TelegramDocument;
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

/** Resolve a Telegram file_id to a server-side file path for download */
async function getFilePath(fileId: string): Promise<string> {
  const result = await apiCall<{ file_path: string }>('getFile', { file_id: fileId });
  return result.file_path;
}

/**
 * Download a photo or image document from a Telegram message to /tmp/.
 * Returns the local file path on success, null if the message has no image,
 * or an unsupported marker if it's a non-image document type.
 */
export async function downloadTelegramImage(
  message: NonNullable<TelegramUpdate['message']>
): Promise<{ path: string } | { unsupported: string } | null> {
  let fileId: string;
  let ext = '.jpg';

  if (message.photo && message.photo.length > 0) {
    // Telegram sends multiple resolutions — last is highest quality
    fileId = message.photo[message.photo.length - 1].file_id;
    ext = '.jpg';
  } else if (message.document) {
    const mime = message.document.mime_type ?? '';
    if (!mime.startsWith('image/')) {
      // Non-image document — caller should send a user-facing message
      return { unsupported: mime || 'unknown type' };
    }
    fileId = message.document.file_id;
    // Preserve original extension if available
    const origExt = message.document.file_name ? extname(message.document.file_name) : '';
    ext = origExt || (mime === 'image/png' ? '.png' : mime === 'image/gif' ? '.gif' : '.jpg');
  } else {
    return null; // No image in this message
  }

  const filePath = await getFilePath(fileId);
  const downloadUrl = `${FILE_BASE_URL}/${filePath}`;

  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status} ${res.statusText}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const localPath = join(tmpdir(), `pai-mobile-img-${Date.now()}${ext}`);
  writeFileSync(localPath, buffer);

  return { path: localPath };
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

export interface BotCommand {
  command: string;
  description: string;
}

/** Register bot commands visible in the Telegram / menu */
export async function registerBotCommands(commands: BotCommand[]): Promise<void> {
  await apiCall('setMyCommands', { commands });
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

  // 4. Apply markdown -> HTML conversions
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
