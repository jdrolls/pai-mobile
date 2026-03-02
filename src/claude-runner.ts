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

    const proc = spawn('claude', args, {
      cwd: config.claudeCwd,
      env: opts.systemSession ? cleanEnvForAutomated() : cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],  // stdin must be 'ignore' — 'pipe' blocks claude
    });

    const timer = setTimeout(() => {
      log('warn', `Claude timed out after ${timeout}ms`);
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, timeout);

    // Allow external cancellation via AbortSignal
    if (opts.signal) {
      const onAbort = () => {
        log('info', 'Claude process cancelled by user');
        clearTimeout(timer);
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

    proc.on('close', (code) => {
      clearTimeout(timer);

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

      if (code !== 0 && !text) {
        log('error', `claude exited ${code}`, { stderr: stderr.slice(0, 500) });
        resolve({
          text: `Error running Claude: ${stderr.slice(0, 200) || `exit code ${code}`}`,
          sessionId,
          error: stderr,
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
      log('error', `Failed to spawn claude: ${err.message}`);
      resolve({
        text: `Failed to start Claude Code: ${err.message}`,
        error: err.message,
      });
    });
  });
}
