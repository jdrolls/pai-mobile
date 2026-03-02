/**
 * Permanent memory layer — integrates with PAI's native memory system.
 *
 * Writes to TWO locations for seamless Telegram -> desktop continuity:
 *
 * 1. ~/.claude/MEMORY/TELEGRAM/MEMORY.md
 *    - Permanent cross-session knowledge from Telegram conversations
 *    - Referenced via CONTEXT_ROUTING.md, available to desktop sessions
 *
 * 2. ~/.claude/MEMORY/RELATIONSHIP/YYYY-MM/YYYY-MM-DD.md
 *    - Daily interaction bullets (e.g., "[Telegram 14:32] Discussed X")
 *    - LoadContext.hook.ts ALREADY reads today + yesterday from this path
 *    - Surfaces automatically in desktop Claude Code sessions — zero config
 *
 * Also keeps a local copy at data/memory/ for gateway system prompt injection.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config } from './config.js';
import { log } from './logger.js';

// -- PAI-integrated paths (read by LoadContext.hook.ts on desktop sessions) --
const PAI_MEMORY_ROOT = join(homedir(), '.claude', 'MEMORY');
const PAI_TELEGRAM_DIR = join(PAI_MEMORY_ROOT, 'TELEGRAM');
const PAI_TELEGRAM_MEMORY = join(PAI_TELEGRAM_DIR, 'MEMORY.md');
const PAI_RELATIONSHIP_DIR = join(PAI_MEMORY_ROOT, 'RELATIONSHIP');

// -- Local gateway paths (for system prompt injection in Telegram sessions) --
const LOCAL_MEMORY_DIR = join(config.dataDir, 'memory');
const LOCAL_MEMORY_PATH = join(LOCAL_MEMORY_DIR, 'MEMORY.md');
const LOCAL_DAILY_DIR = join(LOCAL_MEMORY_DIR, 'daily');

const MAX_MEMORY_CHARS = 8_000;

export function ensureMemoryDirs(): void {
  // Local gateway dirs
  mkdirSync(LOCAL_MEMORY_DIR, { recursive: true });
  mkdirSync(LOCAL_DAILY_DIR, { recursive: true });
  // PAI integration dirs
  mkdirSync(PAI_TELEGRAM_DIR, { recursive: true });
}

/** Load permanent memory content (tries PAI path first, falls back to local) */
export function loadMemory(): string {
  // Prefer PAI-integrated path (richer content from desktop sessions too)
  for (const path of [PAI_TELEGRAM_MEMORY, LOCAL_MEMORY_PATH]) {
    if (existsSync(path)) {
      try {
        return readFileSync(path, 'utf-8').slice(0, MAX_MEMORY_CHARS);
      } catch (e) {
        log('error', `Failed to read ${path}: ${e}`);
      }
    }
  }
  return '';
}

/**
 * Append a timestamped entry to daily logs.
 * Writes to TWO places:
 * 1. PAI RELATIONSHIP dir (auto-loaded by desktop LoadContext)
 * 2. Local gateway daily log (detailed, for gateway reference)
 */
export function appendDailyLog(
  sessionName: string,
  userMessage: string,
  assistantResponse: string,
): void {
  const now = new Date();
  const today = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`; // YYYY-MM
  const time = now.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: config.timezone,
  });

  const userSnippet = userMessage.slice(0, 200).replace(/\n/g, ' ');
  const assistSnippet = assistantResponse.slice(0, 200).replace(/\n/g, ' ');

  // -- Write to PAI RELATIONSHIP (LoadContext reads bullet points from here) --
  try {
    const relDir = join(PAI_RELATIONSHIP_DIR, yearMonth);
    mkdirSync(relDir, { recursive: true });
    const relPath = join(relDir, `${today}.md`);
    // Bullet format that LoadContext extracts (lines starting with "- ")
    const bullet = `- [Telegram ${time}] ${userSnippet.slice(0, 100)}\n`;
    if (!existsSync(relPath)) {
      writeFileSync(relPath, `# Relationship Notes — ${today}\n\n${bullet}`);
    } else {
      appendFileSync(relPath, bullet);
    }
  } catch (e) {
    log('error', `Failed to write PAI relationship log: ${e}`);
  }

  // -- Write to local gateway daily log (more detailed) --
  try {
    const logPath = join(LOCAL_DAILY_DIR, `${today}.md`);
    const entry = `### ${time} [${sessionName}]\n- **User:** ${userSnippet}\n- **${config.botName}:** ${assistSnippet}\n\n`;
    if (!existsSync(logPath)) {
      writeFileSync(logPath, `# Daily Log — ${today}\n\n${entry}`);
    } else {
      appendFileSync(logPath, entry);
    }
  } catch (e) {
    log('error', `Failed to write local daily log: ${e}`);
  }
}

/** Save content to MEMORY.md (writes to both PAI and local, atomic) */
export function saveMemory(content: string): void {
  ensureMemoryDirs();
  const capped = content.slice(0, MAX_MEMORY_CHARS);

  // Write to PAI-integrated location
  const paiTmp = PAI_TELEGRAM_MEMORY + '.tmp';
  try {
    writeFileSync(paiTmp, capped);
    renameSync(paiTmp, PAI_TELEGRAM_MEMORY);
  } catch (e) {
    log('error', `Failed to save PAI TELEGRAM MEMORY.md: ${e}`);
    try { unlinkSync(paiTmp); } catch { /* ignore */ }
  }

  // Write to local gateway location
  const localTmp = LOCAL_MEMORY_PATH + '.tmp';
  try {
    writeFileSync(localTmp, capped);
    renameSync(localTmp, LOCAL_MEMORY_PATH);
  } catch (e) {
    log('error', `Failed to save local MEMORY.md: ${e}`);
    try { unlinkSync(localTmp); } catch { /* ignore */ }
  }
}

/** Initialize MEMORY.md with a default template if neither location exists */
export function initMemoryIfNeeded(): void {
  ensureMemoryDirs();
  if (!existsSync(PAI_TELEGRAM_MEMORY) && !existsSync(LOCAL_MEMORY_PATH)) {
    const template = `# ${config.botName} Telegram Memory

## About ${config.userName}
- Timezone: ${config.timezone}

## Preferences
<!-- Learned preferences from Telegram conversations -->

## Active Context
<!-- Current topics and ongoing work discussed via Telegram -->
`;
    saveMemory(template);
    log('info', 'Initialized TELEGRAM MEMORY.md with default template');
  }
}
