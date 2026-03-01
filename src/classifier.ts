import { log } from './logger.js';

export type Mode = 'lite' | 'full';

/**
 * Fast local classifier — no LLM call needed.
 * Uses keyword matching to determine mode.
 * User can always override with /lite or /full commands.
 */

const FULL_PATTERNS = [
  // Coding / development
  /\b(code|coding|debug|bug|fix|refactor|implement|deploy|build|compile|test|git|commit|push|pull|merge|branch|PR|pull request)\b/i,
  // File operations
  /\b(file|edit|create|delete|write|read|mkdir|directory|folder|path)\b/i,
  // System administration
  /\b(ssh|server|service|systemctl|docker|container|process|kill|restart|install|npm|pip|brew)\b/i,
  // Analysis / complex work
  /\b(analyze|architect|design|plan|review|audit|security|pentest|research)\b/i,
  // Project references
  /\b(project|repo|repository|codebase|module|component|API|endpoint|database|schema|migration)\b/i,
  // Explicit complexity signals
  /\b(help me (build|create|fix|implement|debug|write))\b/i,
  /\b(can you (look at|check|review|fix|update|modify))\b/i,
  // Multi-step indicators
  /\b(step by step|first .+ then|walk me through)\b/i,
];

const LITE_OVERRIDE_PATTERNS = [
  // Calendar / email (always lite even if other keywords present)
  /\b(calendar|schedule|meeting|appointment|email|inbox|gmail)\b/i,
  // Simple queries
  /\b(weather|time|date|remind|reminder|note)\b/i,
  // Quick lookups
  /^(what|who|when|where|how much|how many)\b.{0,50}$/i,
];

export function classifyMessage(message: string): Mode {
  // Short messages are almost always lite
  if (message.length < 20) {
    log('info', `Classified as lite (short message: ${message.length} chars)`);
    return 'lite';
  }

  // Check for lite override patterns first (calendar, email, etc.)
  for (const pattern of LITE_OVERRIDE_PATTERNS) {
    if (pattern.test(message)) {
      log('info', `Classified as lite (matched lite pattern: ${pattern})`);
      return 'lite';
    }
  }

  // Check for full mode patterns
  for (const pattern of FULL_PATTERNS) {
    if (pattern.test(message)) {
      log('info', `Classified as full (matched: ${pattern})`);
      return 'full';
    }
  }

  // Default to lite
  log('info', 'Classified as lite (no full patterns matched)');
  return 'lite';
}
