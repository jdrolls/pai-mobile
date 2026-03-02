/**
 * Shared helper to run inference through `claude -p` (uses Claude Max plan).
 * All modes route through here — no direct Anthropic API calls.
 *
 * Key: We must strip ALL Claude Code env vars from the spawned process,
 * otherwise:
 * - CLAUDECODE=1 → "cannot launch inside another session" error
 * - ANTHROPIC_API_KEY → uses API billing instead of Max plan
 * - CLAUDE_CODE_* → various interference with fresh sessions
 */
import { spawn } from 'child_process';
import { config } from './config.js';
import { log } from './logger.js';

export interface ClaudeRunResult {
  text: string;
  sessionId?: string;
  error?: string;
}

export interface ClaudeRunOptions {
  message: string;
  model?: string;
  systemPrompt?: string;
  resumeSessionId?: string;
  noSessionPersistence?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  systemSession?: boolean;
}

/** Build a clean env with all Claude Code vars stripped (for user sessions) */
function cleanEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  // Remove ALL Claude Code session markers
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  delete env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  // Remove API key so claude uses Max plan auth instead of API billing
  delete env.ANTHROPIC_API_KEY;
  return env;
}

/** Build a minimal allowlist env for automated/system sessions (heartbeat, cron) */
function cleanEnvForAutomated(): Record<string, string> {
  const ALLOWED = ['HOME', 'PATH', 'USER', 'TMPDIR', 'TERM', 'LANG', 'SHELL', 'CLAUDE_CONFIG_DIR'];
  const env: Record<string, string> = {};
  for (const key of ALLOWED) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const args = [
    '-p', opts.message,
    '--output-format', 'json',  // json = single result (stream-json requires --verbose)
    '--model', opts.model ?? config.fullModel,
  ];

  if (opts.systemPrompt) {
    args.push('--system-prompt', opts.systemPrompt);
  }

  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }

  if (opts.noSessionPersistence) {
    args.push('--no-session-persistence');
  }

  // Permission mode: restricted for system sessions, configurable for user sessions
  if (opts.systemSession) {
    args.push('--permission-mode', 'default');
  } else {
    args.push('--permission-mode', config.claudePermissionMode);
  }

  log('info', `Running: claude -p "${opts.message.slice(0, 50)}..." --model ${opts.model ?? config.fullModel}`);

  const timeout = opts.timeoutMs ?? config.fullTimeoutMs;

  return new Promise<ClaudeRunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;

    const proc = spawn('claude', args, {
      cwd: config.claudeCwd,
      env: opts.systemSession ? cleanEnvForAutomated() : cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],  // stdin must be 'ignore' — 'pipe' blocks claude
    });

    const timeoutMin = Math.round(timeout / 60_000);
    const timer = setTimeout(() => {
      timedOut = true;
      log('warn', `Claude safety timeout after ${timeoutMin}m — process killed`);
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, timeout);

    // Health check: detect zombie processes (close event never fired)
    const healthCheck = setInterval(() => {
      try {
        process.kill(proc.pid!, 0); // kill(0) tests existence without signaling
      } catch {
        log('warn', `Claude process ${proc.pid} appears dead (no close event). Forcing resolve.`);
        clearTimeout(timer);
        clearInterval(healthCheck);
        resolve({
          text: stdout.trim() || 'The task ended unexpectedly without output. Try again.',
          error: 'Process disappeared without close event',
        });
      }
    }, 30_000);

    // Allow external cancellation via AbortSignal
    if (opts.signal) {
      const onAbort = () => {
        cancelled = true;
        log('info', 'Claude process cancelled by user');
        clearTimeout(timer);
        clearInterval(healthCheck);
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 3000);
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      proc.on('close', () => opts.signal!.removeEventListener('abort', onAbort));
    }

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      clearInterval(healthCheck);

      // Parse the JSON result
      let text = '';
      let sessionId: string | undefined;

      try {
        // --output-format json produces one JSON object (possibly duplicated on stderr)
        const lines = stdout.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const result = JSON.parse(line);
            if (result.type === 'result') {
              text = result.result ?? '';
              sessionId = result.session_id;
              break;
            }
          } catch {
            // Non-JSON line
          }
        }
      } catch {
        text = stdout.trim();
      }

      // Fallback: use raw stdout if no JSON parsed
      if (!text && stdout.trim()) {
        text = stdout.trim();
      }

      // Build user-friendly error message for non-zero / signal exits
      if ((code !== 0 && code !== null) || signal || timedOut || cancelled) {
        // If we got usable text despite the error, return it (partial result)
        if (text) {
          const suffix = timedOut ? '\n\n⏱ *Note: this response may be incomplete — the task timed out.*' : '';
          log('info', `Claude produced partial output (${text.length} chars) despite ${timedOut ? 'timeout' : cancelled ? 'cancel' : `exit ${code}/${signal}`}`);
          resolve({
            text: text + suffix,
            sessionId,
          });
          return;
        }

        // No text — build a descriptive error
        let errorMsg: string;
        if (timedOut) {
          errorMsg = `This task hit the ${timeoutMin > 60 ? Math.round(timeoutMin / 60) + '-hour' : timeoutMin + '-minute'} safety limit and was stopped. For long tasks, use /cancel if they appear hung.`;
        } else if (cancelled) {
          errorMsg = 'Task was cancelled.';
        } else if (signal) {
          errorMsg = `Claude was interrupted (${signal}).`;
        } else {
          errorMsg = `Error running Claude: ${stderr.slice(0, 200) || `exit code ${code}`}`;
        }

        log('error', `claude exited code=${code} signal=${signal} timedOut=${timedOut}`, { stderr: stderr.slice(0, 500) });
        resolve({
          text: errorMsg,
          sessionId,
          error: stderr || errorMsg,
        });
        return;
      }

      log('info', `Claude responded: ${text.length} chars, session: ${sessionId ?? 'none'}`);
      resolve({
        text: text || 'Processed but no output.',
        sessionId,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(healthCheck);
      log('error', `Failed to spawn claude: ${err.message}`);
      resolve({
        text: `Failed to start Claude Code: ${err.message}`,
        error: err.message,
      });
    });
  });
}
