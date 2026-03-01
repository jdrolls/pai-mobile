import { readFileSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import { log } from './logger.js';
import { setClaudeSessionId } from './sessions.js';
import { runClaude } from './claude-runner.js';

let fullSystemPrompt: string;

function getSystemPrompt(): string {
  if (!fullSystemPrompt) {
    const promptPath = join(config.promptDir, 'full-system.md');
    try {
      let raw = readFileSync(promptPath, 'utf-8');
      // Inject identity from config
      raw = raw.replace(/\{\{BOT_NAME\}\}/g, config.botName);
      raw = raw.replace(/\{\{USER_NAME\}\}/g, config.userName);
      fullSystemPrompt = raw;
    } catch {
      log('warn', 'full-system.md not found, running without system prompt');
      fullSystemPrompt = '';
    }
  }
  return fullSystemPrompt;
}

export interface FullResponse {
  text: string;
  sessionId?: string;
  error?: string;
}

export async function handleFull(
  message: string,
  mobileSessionId: string,
  claudeSessionId?: string,
  signal?: AbortSignal,
): Promise<FullResponse> {
  const systemPrompt = getSystemPrompt();
  const result = await runClaude({
    message,
    model: config.fullModel,
    // Only pass system prompt on first message (no existing session)
    systemPrompt: claudeSessionId ? undefined : (systemPrompt || undefined),
    resumeSessionId: claudeSessionId,
    timeoutMs: config.fullTimeoutMs,
    signal,
  });

  // Save the Claude session ID for future continuity
  if (result.sessionId) {
    setClaudeSessionId(mobileSessionId, result.sessionId);
  }

  log('info', `Full mode response: ${result.text.length} chars, session: ${result.sessionId}`);

  return {
    text: result.text,
    sessionId: result.sessionId,
    error: result.error,
  };
}
