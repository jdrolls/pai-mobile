import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';

const LOG_DIR = join(config.dataDir, 'logs');
mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = join(LOG_DIR, 'gateway.log');

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[MIN_LEVEL]) return;

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  const line = meta
    ? `${prefix} ${message} ${JSON.stringify(meta)}`
    : `${prefix} ${message}`;

  console.log(line);

  try {
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // Can't log the logging failure, just continue
  }
}
