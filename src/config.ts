import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// Derive project root from this file's location (src/ -> project root)
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

// Load .env from project root
const envPath = join(PROJECT_DIR, '.env');

if (existsSync(envPath)) {
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

// Load heartbeat config
const heartbeatConfigPath = join(PROJECT_DIR, 'data', 'heartbeat-config.json');
let heartbeatConfig = {
  enabled: false,
  intervalMs: 3600000,
  activeHours: { start: '07:00', end: '22:00' },
  timezone: process.env.TIMEZONE ?? 'America/Denver',
  model: 'sonnet',
  heartbeatMdPath: '~/.claude/HEARTBEAT.md',
  ackMaxChars: 300,
  maxConsecutiveFailures: 3,
  circuitBreakerPauseMs: 3600000,
};
if (existsSync(heartbeatConfigPath)) {
  try {
    heartbeatConfig = JSON.parse(readFileSync(heartbeatConfigPath, 'utf-8'));
  } catch (e) {
    console.warn(`Failed to parse heartbeat config: ${e}`);
  }
}

export const config = {
  // Identity
  botName: process.env.BOT_NAME ?? 'PAI Mobile',
  userName: process.env.USER_NAME ?? 'User',

  // Telegram
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  authorizedChatIds: (process.env.TELEGRAM_CHAT_ID ?? '').split(',').map(s => s.trim()).filter(Boolean),

  // Paths
  projectDir: PROJECT_DIR,
  dataDir: join(PROJECT_DIR, 'data'),
  promptDir: join(PROJECT_DIR, 'prompts'),

  // Heartbeat + Cron
  heartbeat: heartbeatConfig,
  timezone: process.env.TIMEZONE ?? 'America/Denver',

  // Claude Code
  claudeCwd: homedir(), // Run claude from home dir for full context access
  claudePermissionMode: (process.env.PERMISSION_MODE ?? 'default') as string,

  // Telegram limits
  telegramMsgLimit: 4000,
  pollTimeoutSec: 30,
  typingIntervalMs: 4000,

  // Timeouts
  liteTimeoutMs: 120_000,       // 2 min for lite mode
  fullTimeoutMs: 10 * 60_000,   // 10 min for full mode
  classifierTimeoutMs: 60_000,  // 60s for classifier
  longTaskThresholdMs: 15_000,  // 15s before sending "this will take a bit" ping

  // Rate limits
  maxMessagesPerMinute: parseInt(process.env.MAX_MESSAGES_PER_MINUTE ?? '20', 10),
  maxConcurrentClaude: parseInt(process.env.MAX_CONCURRENT_CLAUDE ?? '3', 10),

  // Models
  classifierModel: 'haiku',
  liteModel: process.env.LITE_MODEL ?? 'sonnet',
  fullModel: process.env.FULL_MODEL ?? 'sonnet',
} as const;

// Validate required config
const missing: string[] = [];
if (!config.telegramToken) missing.push('TELEGRAM_BOT_TOKEN');
if (!config.authorizedChatIds.length) missing.push('TELEGRAM_CHAT_ID');

if (missing.length > 0) {
  console.error(`FATAL: Missing environment variables: ${missing.join(', ')}`);
  console.error(`Set them in ${envPath} or as environment variables.`);
  console.error('See .env.example for the full list.');
  process.exit(1);
}
