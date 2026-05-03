/**
 * Voice handler — Telegram voice notes <-> text via Whisper STT and ElevenLabs TTS.
 *
 * Pipeline:
 *   inbound:  Telegram voice → getFile → /tmp OGG → whisper CLI → text
 *   outbound: text → length-gate → ElevenLabs TTS (OGG/opus) → Telegram sendVoice
 *
 * Voice mode is mirror-by-default per chat:
 *   voice-in → voice-out, text-in → text-out.
 * The mirror state for the current chat is set by the caller via setVoiceMode.
 *
 * Voice ID is read from ~/.claude/settings.json daidentity.voices.main.voiceId
 * via getVoiceId(). Never hardcoded.
 *
 * Failure modes always degrade to text — STT/TTS errors NEVER drop the message.
 */

import { writeFileSync, readFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, basename } from 'path';
import { spawn } from 'child_process';
import { config } from './config.js';
import { log } from './logger.js';

// --- Telegram voice message shape -------------------------------------------

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

// --- Voice ID resolution ----------------------------------------------------

let cachedVoiceId: string | null = null;

/**
 * Read main voice ID from ~/.claude/settings.json (daidentity.voices.main.voiceId).
 * Mirrors the contract used by hooks/lib/identity.ts in the PAI repo: settings.json
 * is the canonical source of truth — never hardcode an ElevenLabs voice ID literal.
 *
 * Falls back to env var ELEVENLABS_VOICE_ID if settings.json is unavailable.
 */
export function getVoiceId(): string | null {
  if (cachedVoiceId !== null) return cachedVoiceId;
  const fromEnv = process.env.ELEVENLABS_VOICE_ID;
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  try {
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const da = parsed.daidentity as Record<string, unknown> | undefined;
      const voices = da?.voices as Record<string, unknown> | undefined;
      const main = voices?.main as Record<string, unknown> | undefined;
      const id = main?.voiceId;
      if (typeof id === 'string' && id.length > 0) {
        cachedVoiceId = id;
        return id;
      }
    }
  } catch (e) {
    log('warn', `getVoiceId: failed to read settings.json: ${e}`);
  }
  if (fromEnv && fromEnv.length > 0) {
    cachedVoiceId = fromEnv;
    return fromEnv;
  }
  return null;
}

// --- Per-chat mirror mode ---------------------------------------------------

type VoiceMode = 'voice' | 'text';
const chatVoiceMode = new Map<string, VoiceMode>();

/** Returns 'voice' if the last inbound on this chat was voice; 'text' otherwise (default). */
export function getVoiceMode(chatStr: string): VoiceMode {
  return chatVoiceMode.get(chatStr) ?? 'text';
}

/** Mirror-by-default: caller sets 'voice' when inbound was a voice note. */
export function setVoiceMode(chatStr: string, mode: VoiceMode): void {
  chatVoiceMode.set(chatStr, mode);
}

// --- Telegram API plumbing (small subset, separate from telegram.ts to keep it lean) ---

const BOT_BASE = `https://api.telegram.org/bot${config.telegramToken}`;
const FILE_BASE = `https://api.telegram.org/file/bot${config.telegramToken}`;

async function tgGetFilePath(fileId: string): Promise<string> {
  const res = await fetch(`${BOT_BASE}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  const data = await res.json() as { ok: boolean; result?: { file_path: string }; description?: string };
  if (!data.ok || !data.result) {
    throw new Error(`Telegram getFile failed: ${data.description ?? 'unknown'}`);
  }
  return data.result.file_path;
}

/**
 * Download a Telegram voice note to a local OGG/Opus file under /tmp.
 * Voice notes always come as OGG/Opus per Telegram Bot API.
 */
export async function downloadTelegramVoice(voice: TelegramVoice): Promise<string> {
  const filePath = await tgGetFilePath(voice.file_id);
  const url = `${FILE_BASE}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Voice download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const local = join(tmpdir(), `pai-mobile-voice-${Date.now()}-${basename(filePath)}`);
  writeFileSync(local, buf);
  return local;
}

/**
 * Send an OGG/Opus file as a Telegram voice note via sendVoice (multipart/form-data).
 */
export async function sendVoice(chatId: number | string, oggPath: string, caption?: string): Promise<void> {
  const buf = readFileSync(oggPath);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption.slice(0, 1024));
  form.append('voice', new Blob([buf], { type: 'audio/ogg' }), basename(oggPath));
  const res = await fetch(`${BOT_BASE}/sendVoice`, { method: 'POST', body: form });
  const data = await res.json() as { ok: boolean; description?: string };
  if (!data.ok) throw new Error(`sendVoice failed: ${data.description ?? 'unknown'}`);
}

// --- STT (Whisper) ----------------------------------------------------------

/**
 * Transcribe an OGG/Opus file via the local `whisper` CLI (insanely-fast-whisper
 * compatible / openai-whisper compatible). Outputs txt to a temp dir, reads it back.
 *
 * Returns the trimmed transcript or throws on failure. Caller is responsible
 * for catching and falling back to text mode.
 */
export async function transcribeAudio(oggPath: string, signal?: AbortSignal): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'pai-mobile-stt-'));
  try {
    const model = process.env.WHISPER_MODEL ?? 'base.en';
    const args = [
      oggPath,
      '--model', model,
      '--output_dir', outDir,
      '--output_format', 'txt',
      '--language', 'en',
      '--fp16', 'False',
      '--verbose', 'False',
    ];
    await runCommand('whisper', args, signal, 90_000);
    // whisper writes <basename>.txt into outDir
    const files = readdirSync(outDir).filter(f => f.endsWith('.txt'));
    if (files.length === 0) throw new Error('whisper produced no .txt output');
    const text = readFileSync(join(outDir, files[0]), 'utf-8').trim();
    if (!text) throw new Error('whisper transcript is empty');
    return text;
  } finally {
    try { rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function runCommand(cmd: string, args: string[], signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    const onAbort = () => { try { child.kill('SIGTERM'); } catch { /* */ } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* */ }
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

// --- TTS (ElevenLabs) -------------------------------------------------------

/**
 * Synthesize text via ElevenLabs streaming TTS in OGG/Opus (Telegram-native).
 * Returns the local path to the .ogg file. Caller is responsible for catching
 * and falling back to sendMessage.
 *
 * Voice ID is resolved via getVoiceId() — never hardcoded.
 */
export async function synthesizeSpeech(text: string, signal?: AbortSignal): Promise<string> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');
  const voiceId = getVoiceId();
  if (!voiceId) throw new Error('voice ID unavailable (settings.json daidentity.voices.main.voiceId missing)');

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=opus_48000_64`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/ogg',
    },
    body: JSON.stringify({
      text,
      model_id: process.env.ELEVENLABS_MODEL_ID ?? 'eleven_turbo_v2_5',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.3,
        use_speaker_boost: true,
      },
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const out = join(tmpdir(), `pai-mobile-tts-${Date.now()}.ogg`);
  writeFileSync(out, buf);
  return out;
}

// --- Length gate ------------------------------------------------------------

// Telegram voice notes work fine up to a few minutes, but long monologues are
// awful UX on phone speakers. ~30s of speech ≈ 75-90 words ≈ ~450 chars.
// Gate at 800 chars: under = TTS, over = text fallback (callers get the bool).
export const TTS_MAX_CHARS = parseInt(process.env.TTS_MAX_CHARS ?? '800', 10);

export interface VoiceReplyDecision {
  /** Whether voice TTS is appropriate for this reply. */
  useVoice: boolean;
  /** Reason for the decision (logged, not user-facing). */
  reason: string;
}

/** Decide whether outbound should be voice. Mirror mode + length gate + key/id presence. */
export function decideVoiceReply(chatStr: string, text: string): VoiceReplyDecision {
  const mode = getVoiceMode(chatStr);
  if (mode !== 'voice') return { useVoice: false, reason: 'text-mode' };
  if (text.length > TTS_MAX_CHARS) return { useVoice: false, reason: `length>${TTS_MAX_CHARS}` };
  if (!process.env.ELEVENLABS_API_KEY) return { useVoice: false, reason: 'no-api-key' };
  if (!getVoiceId()) return { useVoice: false, reason: 'no-voice-id' };
  return { useVoice: true, reason: 'mirror' };
}
