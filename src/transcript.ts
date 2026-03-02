/**
 * Transcript persistence layer — records conversation history to JSONL files.
 *
 * Primary purpose: safety net for when --resume fails (Claude prunes sessions).
 * Also enables context injection on new sessions that have prior history.
 *
 * Design decisions (from red team analysis):
 * - JSONL append (not JSON array) — append-friendly, survives partial writes
 * - Simple truncation (not LLM compaction) — deterministic, zero latency
 * - Transcript injected ONLY when --resume is unavailable — never concurrent
 * - Content truncated per-entry to prevent unbounded growth
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import { log } from './logger.js';

interface TranscriptEntry {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

const TRANSCRIPTS_DIR = join(config.dataDir, 'transcripts');
const MAX_ENTRY_CHARS = 50_000;   // Truncate very long messages
const MAX_READ_ENTRIES = 40;       // Last N entries to read
const MAX_INJECT_CHARS = 8_000;    // Budget for context injection

export function ensureTranscriptsDir(): void {
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
}

function transcriptPath(sessionId: string): string {
  return join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
}

/** Append a single turn to the session transcript */
export function appendTranscript(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
): void {
  const entry: TranscriptEntry = {
    role,
    content: content.slice(0, MAX_ENTRY_CHARS),
    ts: Date.now(),
  };
  try {
    appendFileSync(transcriptPath(sessionId), JSON.stringify(entry) + '\n');
  } catch (e) {
    log('error', `Transcript append failed [${sessionId}]: ${e}`);
  }
}

/** Read the last N entries from a session transcript */
export function readRecentTranscript(
  sessionId: string,
  maxEntries: number = MAX_READ_ENTRIES,
): TranscriptEntry[] {
  const path = transcriptPath(sessionId);
  if (!existsSync(path)) return [];

  try {
    const raw = readFileSync(path, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const start = Math.max(0, lines.length - maxEntries);
    const entries: TranscriptEntry[] = [];

    for (let i = start; i < lines.length; i++) {
      try {
        entries.push(JSON.parse(lines[i]));
      } catch {
        // Skip malformed lines
      }
    }
    return entries;
  } catch (e) {
    log('error', `Transcript read failed [${sessionId}]: ${e}`);
    return [];
  }
}

/**
 * Format transcript as a context block for system prompt injection.
 * Returns empty string if no transcript exists.
 *
 * Respects character budget by including most recent turns first,
 * stopping when budget is exceeded (simple truncation, not LLM compaction).
 */
export function formatTranscriptForContext(
  sessionId: string,
  maxChars: number = MAX_INJECT_CHARS,
): string {
  const entries = readRecentTranscript(sessionId);
  if (entries.length === 0) return '';

  // Build from most recent, stay within budget
  const lines: string[] = [];
  let totalChars = 0;

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const label = e.role === 'user' ? 'User' : config.botName;
    const line = `${label}: ${e.content}`;
    if (totalChars + line.length + 2 > maxChars) break;
    lines.unshift(line);
    totalChars += line.length + 2; // +2 for \n\n separator
  }

  if (lines.length === 0) return '';

  return [
    '',
    '---',
    `Previous conversation (${lines.length} messages):`,
    '',
    lines.join('\n\n'),
    '---',
  ].join('\n');
}

/** Check if a transcript exists for a session */
export function hasTranscript(sessionId: string): boolean {
  return existsSync(transcriptPath(sessionId));
}
