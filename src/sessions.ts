import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import { log } from './logger.js';

export interface Session {
  id: string;
  claudeSessionId?: string; // Claude Code session ID for full mode
  name: string;
  mode: 'auto' | 'lite' | 'full';
  modeOverride?: 'lite' | 'full'; // Manual override via /lite or /full
  messageCount: number;
  createdAt: number;
  lastActive: number;
  contextRecovery?: boolean; // True when --resume failed and transcript should be injected
}

interface SessionStore {
  activeSessionId: Record<string, string>; // chatId -> sessionId
  sessions: Record<string, Session>;
}

const STORE_PATH = join(config.dataDir, 'sessions.json');

let store: SessionStore = { activeSessionId: {}, sessions: {} };

export function loadSessions(): void {
  mkdirSync(config.dataDir, { recursive: true });
  if (existsSync(STORE_PATH)) {
    try {
      store = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
    } catch (e) {
      log('warn', `Failed to parse sessions file, starting fresh: ${e}`);
      store = { activeSessionId: {}, sessions: {} };
    }
  }
}

function saveSessions(): void {
  const tmpPath = STORE_PATH + '.tmp';
  try {
    writeFileSync(tmpPath, JSON.stringify(store, null, 2));
    renameSync(tmpPath, STORE_PATH); // Atomic on POSIX
  } catch (e) {
    log('error', `Failed to save sessions: ${e}`);
    // Clean up temp file if rename failed
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `mob_${ts}_${rand}`;
}

function autoName(message?: string): string {
  if (!message) return `Session ${Object.keys(store.sessions).length + 1}`;
  // Take first ~30 chars, trim to last word boundary
  const clean = message.replace(/[^\w\s]/g, '').trim();
  const short = clean.length > 30 ? clean.slice(0, 30).replace(/\s\S*$/, '') : clean;
  return short || `Session ${Object.keys(store.sessions).length + 1}`;
}

export function createSession(chatId: string, name?: string): Session {
  const id = generateId();
  const session: Session = {
    id,
    name: name ?? `Session ${Object.keys(store.sessions).length + 1}`,
    mode: 'auto',
    messageCount: 0,
    createdAt: Date.now(),
    lastActive: Date.now(),
  };
  store.sessions[id] = session;
  store.activeSessionId[chatId] = id;
  saveSessions();
  log('info', `Created session ${id} for chat ${chatId}`);
  return session;
}

export function getActiveSession(chatId: string): Session | null {
  const sessionId = store.activeSessionId[chatId];
  if (!sessionId || !store.sessions[sessionId]) return null;
  return store.sessions[sessionId];
}

export function getOrCreateSession(chatId: string): Session {
  return getActiveSession(chatId) ?? createSession(chatId);
}

export function switchSession(chatId: string, sessionId: string): Session | null {
  const session = store.sessions[sessionId];
  if (!session) return null;
  store.activeSessionId[chatId] = sessionId;
  saveSessions();
  return session;
}

export function listSessions(): Session[] {
  return Object.values(store.sessions)
    .sort((a, b) => b.lastActive - a.lastActive);
}

export function setModeOverride(sessionId: string, mode: 'lite' | 'full' | undefined): void {
  const session = store.sessions[sessionId];
  if (session) {
    session.modeOverride = mode;
    saveSessions();
  }
}

export function updateSession(sessionId: string, updates: Partial<Session>): void {
  const session = store.sessions[sessionId];
  if (session) {
    Object.assign(session, updates, { lastActive: Date.now() });
    saveSessions();
  }
}

export function autoNameSession(sessionId: string, message: string): void {
  const session = store.sessions[sessionId];
  if (session && session.name.startsWith('Session ') && session.messageCount === 0) {
    session.name = autoName(message);
    saveSessions();
  }
}

export function setClaudeSessionId(sessionId: string, claudeSessionId: string): void {
  const session = store.sessions[sessionId];
  if (session) {
    session.claudeSessionId = claudeSessionId;
    saveSessions();
  }
}
