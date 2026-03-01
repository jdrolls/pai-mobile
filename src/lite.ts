import { readFileSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import { log } from './logger.js';
import { runClaude } from './claude-runner.js';

let liteSystemPrompt: string;

function getSystemPrompt(): string {
  if (!liteSystemPrompt) {
    const promptPath = join(config.promptDir, 'lite-system.md');
    try {
      let raw = readFileSync(promptPath, 'utf-8');
      // Inject identity from config
      raw = raw.replace(/\{\{BOT_NAME\}\}/g, config.botName);
      raw = raw.replace(/\{\{USER_NAME\}\}/g, config.userName);
      liteSystemPrompt = raw;
    } catch {
      log('warn', 'lite-system.md not found, using fallback prompt');
      liteSystemPrompt = getFallbackPrompt();
    }
  }
  return liteSystemPrompt;
}

function getFallbackPrompt(): string {
  return `You are ${config.botName}, ${config.userName}'s AI assistant. You're helpful, direct, and have a warm personality with a touch of wit. Keep responses concise and useful.

For trivial tasks (greetings, quick lookups): just respond naturally.

Current date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;
}

export interface LiteResponse {
  text: string;
  sessionId?: string;
}

export async function handleLite(
  message: string,
  _mobileSessionId: string,
  _claudeSessionId?: string,
  signal?: AbortSignal,
): Promise<LiteResponse> {
  // Lite mode is stateless — no session resume.
  // Resuming sessions carries dangerous context (e.g., "implement code changes")
  // that causes Claude to continue prior work on unrelated messages.
  const result = await runClaude({
    message,
    model: config.liteModel,
    systemPrompt: getSystemPrompt(),
    timeoutMs: config.liteTimeoutMs,
    signal,
  });

  if (result.error) {
    log('error', `Lite mode error: ${result.error}`);
  }

  return { text: result.text, sessionId: result.sessionId };
}
