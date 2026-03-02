import { readFileSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import { log } from './logger.js';
import { setClaudeSessionId } from './sessions.js';
import { runClaude } from './claude-runner.js';
import { formatTranscriptForContext } from './transcript.js';
import { loadMemory } from './memory.js';

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
  resumeFailed?: boolean; // True when --resume returned a different session (pruned)
}

export async function handleFull(
  message: string,
  mobileSessionId: string,
  claudeSessionId?: string,
  signal?: AbortSignal,
  options?: { injectTranscript?: boolean },
): Promise<FullResponse> {
  const basePrompt = getSystemPrompt();

  let effectiveSystemPrompt: string | undefined;
  let effectiveMessage = message;

  if (!claudeSessionId) {
    // -- New session: inject base prompt + permanent memory + transcript --
    const memory = loadMemory();
    const transcript = formatTranscriptForContext(mobileSessionId);

    effectiveSystemPrompt = basePrompt
      + (memory ? `\n\n## Permanent Memory\n${memory}` : '')
      + transcript;

    log('info', `New session: injecting system prompt (${effectiveSystemPrompt.length} chars)`);
  } else if (options?.injectTranscript) {
    // -- Context recovery: --resume failed last time, re-seed with transcript --
    // Prepend context to the user message (compatible with --resume)
    const transcript = formatTranscriptForContext(mobileSessionId);
    if (transcript) {
      effectiveMessage = `[Context from our previous conversation — my session was reset:${transcript}]\n\nMy current message: ${message}`;
      log('info', `Context recovery: prepended transcript to message (${transcript.length} chars)`);
    }
  }
  // else: normal resume — Claude has context from its own session state

  const result = await runClaude({
    message: effectiveMessage,
    model: config.fullModel,
    // System prompt only when no existing Claude session
    systemPrompt: claudeSessionId ? undefined : (effectiveSystemPrompt || (basePrompt || undefined)),
    resumeSessionId: claudeSessionId,
    timeoutMs: config.fullTimeoutMs,
    signal,
  });

  // -- Detect resume failure --
  // If we passed a claudeSessionId but got back a DIFFERENT one,
  // the resume failed silently (session was pruned by Claude Code).
  let resumeFailed = false;
  if (claudeSessionId && result.sessionId && result.sessionId !== claudeSessionId) {
    log('warn', `Resume failed silently: passed ${claudeSessionId}, got ${result.sessionId}`);
    resumeFailed = true;
  }

  // Save the Claude session ID for future continuity
  if (result.sessionId) {
    setClaudeSessionId(mobileSessionId, result.sessionId);
  }

  log('info', `Full mode response: ${result.text.length} chars, session: ${result.sessionId}${resumeFailed ? ' [RESUME FAILED]' : ''}`);

  return {
    text: result.text,
    sessionId: result.sessionId,
    error: result.error,
    resumeFailed,
  };
}
