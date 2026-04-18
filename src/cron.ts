/**
 * Cron scheduler — evaluates job schedules on 1-minute ticks, spawns claude -p
 * for due jobs, persists state. Supports natural language schedule parsing.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { CronExpressionParser } from 'cron-parser';
import { runClaude } from './claude-runner.js';
import { enqueueOutbound } from './outbound-queue.js';
import { config } from './config.js';
import { log } from './logger.js';

// ─── System Prompt ──────────────────────────────────────────────
export const CRON_SYSTEM_PROMPT = `You are running a scheduled task. This is a PAI_SYSTEM_SESSION.

RULES:
- Complete the task described below and report the result concisely.
- Do NOT create memory entries, work items, or session artifacts.
- Never include file contents, API keys, tokens, or file paths verbatim in your response.
- Keep output under 2000 characters.
- If the task fails or cannot be completed, explain why briefly.`;

// ─── Types ──────────────────────────────────────────────────────
export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: {
    kind: 'cron' | 'every';
    expr: string;       // cron expression or interval in ms
    tz?: string;
  };
  sessionTarget: 'isolated' | 'main';
  model?: string;
  timeoutMs?: number;       // per-job timeout override (default: 300_000 = 5 min)
  silent?: boolean;          // run job but suppress Telegram output
  payload: {
    message: string;
  };
  requiresTools: boolean;
  deleteAfterRun: boolean;
  contextFromJobs?: string[]; // Job IDs whose latest output is injected as context
  state: {
    lastRunAtMs: number;
    lastStatus: 'ok' | 'error' | 'pending';
    lastError?: string;
    consecutiveErrors: number;
    isRunning: boolean;
    backoffUntilMs: number;
  };
}

interface JobStore {
  version: number;
  jobs: CronJob[];
}

// ─── Constants ──────────────────────────────────────────────────
const TICK_INTERVAL_MS = 60_000;  // 1-minute evaluation tick
const MIN_SCHEDULE_INTERVAL_MS = 5 * 60_000;  // 5 minutes minimum
const MAX_JOBS = 25;
const BACKOFF_SCHEDULE = [30_000, 60_000, 300_000, 900_000, 3_600_000]; // 30s, 1m, 5m, 15m, 1h

// ─── State ──────────────────────────────────────────────────────
let jobStore: JobStore = { version: 1, jobs: [] };
let tickTimer: ReturnType<typeof setInterval> | null = null;
let storePath = '';
let chatId: number | string = '';
let isUserProcessing: () => boolean = () => false;
let paused = false;
let lastKnownMtimeMs = 0; // For hot-reload detection

// ─── Public API ─────────────────────────────────────────────────

export function startCron(
  dataDir: string,
  targetChatId: number | string,
  userBusyFn: () => boolean,
): void {
  storePath = join(dataDir, 'cron', 'jobs.json');
  chatId = targetChatId;
  isUserProcessing = userBusyFn;

  // Ensure directory
  mkdirSync(join(dataDir, 'cron'), { recursive: true });

  // Load existing jobs
  loadJobs();
  try { lastKnownMtimeMs = statSync(storePath).mtimeMs; } catch { /* ok */ }

  log('info', `Cron starting: ${jobStore.jobs.length} jobs loaded, tick every ${TICK_INTERVAL_MS / 1000}s`);

  tickTimer = setInterval(() => {
    cronTick().catch(e => log('error', `Cron tick error: ${e}`));
  }, TICK_INTERVAL_MS);
}

export function stopCron(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  log('info', 'Cron stopped');
}

export function pauseCron(): void {
  paused = true;
  log('info', 'Cron paused');
}

export function resumeCron(): void {
  paused = false;
  log('info', 'Cron resumed');
}

// ─── Job Management ─────────────────────────────────────────────

export function addJob(
  name: string,
  scheduleInput: string,
  message: string,
  opts?: { model?: string; requiresTools?: boolean; deleteAfterRun?: boolean },
): CronJob | { error: string } {
  if (jobStore.jobs.length >= MAX_JOBS) {
    return { error: `Maximum ${MAX_JOBS} jobs reached` };
  }

  const parsed = parseNaturalSchedule(scheduleInput);
  if ('error' in parsed) return parsed;

  const tz = config.timezone ?? 'UTC';

  // Validate minimum interval
  if (parsed.kind === 'cron') {
    try {
      const interval = CronExpressionParser.parse(parsed.expr, { tz });
      const next1 = interval.next().toDate().getTime();
      const next2 = interval.next().toDate().getTime();
      if (next2 - next1 < MIN_SCHEDULE_INTERVAL_MS) {
        return { error: `Schedule interval too short (minimum 5 minutes). Got ~${Math.round((next2 - next1) / 1000)}s.` };
      }
    } catch (e) {
      return { error: `Invalid cron expression: ${e}` };
    }
  }

  const job: CronJob = {
    id: randomUUID().slice(0, 8),
    name: sanitizeName(name),
    enabled: true,
    schedule: { kind: parsed.kind, expr: parsed.expr, tz },
    sessionTarget: 'isolated',
    model: opts?.model,
    payload: { message: message.slice(0, 2000) }, // Max prompt length
    requiresTools: opts?.requiresTools ?? false,
    deleteAfterRun: opts?.deleteAfterRun ?? false,
    state: {
      lastRunAtMs: 0,
      lastStatus: 'pending',
      consecutiveErrors: 0,
      isRunning: false,
      backoffUntilMs: 0,
    },
  };

  jobStore.jobs.push(job);
  saveJobs();
  log('info', `Cron job added: ${job.name} (${job.id}) schedule=${parsed.expr}`);
  return job;
}

export function removeJob(id: string): boolean {
  const idx = jobStore.jobs.findIndex(j => j.id === id);
  if (idx === -1) return false;
  const removed = jobStore.jobs.splice(idx, 1)[0];
  saveJobs();
  log('info', `Cron job removed: ${removed.name} (${id})`);
  return true;
}

export function toggleJob(id: string): CronJob | null {
  const job = jobStore.jobs.find(j => j.id === id);
  if (!job) return null;
  job.enabled = !job.enabled;
  if (job.enabled) {
    job.state.consecutiveErrors = 0;
    job.state.backoffUntilMs = 0;
  }
  saveJobs();
  log('info', `Cron job ${job.enabled ? 'enabled' : 'disabled'}: ${job.name} (${id})`);
  return job;
}

export function listJobs(): CronJob[] {
  return jobStore.jobs;
}

export async function runJobNow(id: string): Promise<string> {
  const job = jobStore.jobs.find(j => j.id === id);
  if (!job) return 'Job not found';
  if (job.state.isRunning) return 'Job is already running';
  await executeJob(job);
  return `Job "${job.name}" executed`;
}

// ─── Core Tick Logic ────────────────────────────────────────────

async function cronTick(): Promise<void> {
  if (paused) return;

  // Hot-reload: check if jobs.json was modified externally
  checkForExternalChanges();

  const now = Date.now();

  for (const job of jobStore.jobs) {
    if (!job.enabled) continue;
    if (job.state.isRunning) continue; // skip-if-running
    if (now < job.state.backoffUntilMs) continue; // in backoff

    if (isDue(job, now)) {
      // Don't block the tick loop — fire and forget but respect concurrency
      if (isUserProcessing()) {
        log('info', `Cron job "${job.name}" deferred: user processing`);
        continue;
      }

      executeJob(job).catch(e => log('error', `Cron execute error for "${job.name}": ${e}`));
    }
  }
}

function isDue(job: CronJob, now: number): boolean {
  if (job.schedule.kind === 'cron') {
    try {
      const interval = CronExpressionParser.parse(job.schedule.expr, {
        tz: job.schedule.tz || 'UTC',
        currentDate: new Date(job.state.lastRunAtMs || now - TICK_INTERVAL_MS * 2),
      });
      const nextRun = interval.next().toDate().getTime();
      return nextRun <= now;
    } catch {
      return false;
    }
  }

  if (job.schedule.kind === 'every') {
    const intervalMs = parseInt(job.schedule.expr);
    if (isNaN(intervalMs)) return false;
    return (now - job.state.lastRunAtMs) >= intervalMs;
  }

  return false;
}

async function executeJob(job: CronJob): Promise<void> {
  job.state.isRunning = true;
  job.state.lastRunAtMs = Date.now();
  saveJobs();

  log('info', `Cron executing: "${job.name}" (${job.id})`);

  try {
    // ── 3.3: Build context from dependent jobs ──
    const jobContext = buildJobContext(job);
    const messageWithContext = jobContext
      ? `[Scheduled Task: ${job.name}]\n${jobContext}${job.payload.message}`
      : `[Scheduled Task: ${job.name}]\n\n${job.payload.message}`;

    const result = await runClaude({
      message: messageWithContext,
      systemPrompt: CRON_SYSTEM_PROMPT,
      noSessionPersistence: true,
      model: job.model || config.fullModel,
      timeoutMs: job.timeoutMs ?? 300_000, // per-job override or 5 min default
      systemSession: true,
    });

    if (result.error) {
      handleJobError(job, result.error);
    } else {
      job.state.lastStatus = 'ok';
      job.state.consecutiveErrors = 0;
      job.state.backoffUntilMs = 0;

      // ── 3.3: Save output for cross-job reference ──
      saveJobResult(job.id, job.name, result.text);

      // SILENT convention: if job is silent OR output is exactly "SILENT", suppress Telegram
      const outputSilent = result.text.trim().toUpperCase() === 'SILENT';
      if (job.silent || outputSilent) {
        log('info', `Cron completed (silent): "${job.name}" — ${result.text.length} chars`);
      } else {
        // Deliver result to Telegram
        enqueueOutbound({
          chatId,
          text: result.text,
          source: 'cron',
          jobName: job.name,
          timestamp: Date.now(),
        });
        log('info', `Cron completed: "${job.name}" — ${result.text.length} chars`);
      }
    }
  } catch (e) {
    handleJobError(job, String(e));
  } finally {
    job.state.isRunning = false;

    if (job.deleteAfterRun && job.state.lastStatus === 'ok') {
      removeJob(job.id);
    } else {
      saveJobs();
    }
  }
}

function handleJobError(job: CronJob, error: string): void {
  job.state.lastStatus = 'error';
  job.state.lastError = error.slice(0, 500);
  job.state.consecutiveErrors++;

  const backoffIdx = Math.min(job.state.consecutiveErrors - 1, BACKOFF_SCHEDULE.length - 1);
  job.state.backoffUntilMs = Date.now() + BACKOFF_SCHEDULE[backoffIdx];

  log('warn', `Cron job "${job.name}" failed (${job.state.consecutiveErrors}x): ${error.slice(0, 200)}`);
}

// ─── Schedule Parsing ───────────────────────────────────────────

export function parseNaturalSchedule(input: string): { kind: 'cron' | 'every'; expr: string } | { error: string } {
  const lower = input.trim().toLowerCase();

  // "every Xm" / "every Xh" / "every X minutes" / "every X hours"
  const everyMatch = lower.match(/^every\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/);
  if (everyMatch) {
    const val = parseInt(everyMatch[1]);
    const unit = everyMatch[2];
    const ms = unit.startsWith('h') ? val * 3_600_000 : val * 60_000;
    if (ms < MIN_SCHEDULE_INTERVAL_MS) {
      return { error: `Minimum interval is 5 minutes` };
    }
    return { kind: 'every', expr: String(ms) };
  }

  // "daily Xam" / "daily Xpm"
  const dailyMatch = lower.match(/^daily\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (dailyMatch) {
    let hour = parseInt(dailyMatch[1]);
    const min = parseInt(dailyMatch[2] || '0');
    const ampm = dailyMatch[3];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return { kind: 'cron', expr: `${min} ${hour} * * *` };
  }

  // "weekdays Xam" / "weekdays Xpm"
  const weekdayMatch = lower.match(/^weekdays?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (weekdayMatch) {
    let hour = parseInt(weekdayMatch[1]);
    const min = parseInt(weekdayMatch[2] || '0');
    const ampm = weekdayMatch[3];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return { kind: 'cron', expr: `${min} ${hour} * * 1-5` };
  }

  // "weekly DAY Xam" e.g., "weekly monday 9am"
  const weeklyMatch = lower.match(/^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\w*\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (weeklyMatch) {
    const dayMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const day = dayMap[weeklyMatch[1]];
    let hour = parseInt(weeklyMatch[2]);
    const min = parseInt(weeklyMatch[3] || '0');
    const ampm = weeklyMatch[4];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return { kind: 'cron', expr: `${min} ${hour} * * ${day}` };
  }

  // "monthly Nth Xam" e.g., "monthly 1st 8am"
  const monthlyMatch = lower.match(/^monthly\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (monthlyMatch) {
    const dayOfMonth = parseInt(monthlyMatch[1]);
    let hour = parseInt(monthlyMatch[2]);
    const min = parseInt(monthlyMatch[3] || '0');
    const ampm = monthlyMatch[4];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return { kind: 'cron', expr: `${min} ${hour} ${dayOfMonth} * *` };
  }

  // Raw cron expression (5 fields)
  const cronMatch = lower.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)$/);
  if (cronMatch) {
    try {
      CronExpressionParser.parse(cronMatch[1]); // validate
      return { kind: 'cron', expr: cronMatch[1] };
    } catch (e) {
      return { error: `Invalid cron expression: ${e}` };
    }
  }

  return {
    error: `Could not parse schedule "${input}". Try: "daily 7am", "every 2h", "weekdays 9am", "weekly monday 8am", "monthly 1st 9am"`,
  };
}

// ─── Persistence ────────────────────────────────────────────────

function loadJobs(): void {
  if (existsSync(storePath)) {
    try {
      jobStore = JSON.parse(readFileSync(storePath, 'utf-8'));
      // Reset running state on load (process restarted)
      for (const job of jobStore.jobs) {
        job.state.isRunning = false;
      }
    } catch (e) {
      log('warn', `Failed to parse cron jobs, starting fresh: ${e}`);
      jobStore = { version: 1, jobs: [] };
    }
  } else {
    jobStore = { version: 1, jobs: [] };
    saveJobs();
  }
}

function saveJobs(): void {
  writeFileSync(storePath, JSON.stringify(jobStore, null, 2));
  // Track our own write so we don't reload it as an external change
  try { lastKnownMtimeMs = statSync(storePath).mtimeMs; } catch { /* best effort */ }
}

function checkForExternalChanges(): void {
  if (!storePath || !existsSync(storePath)) return;
  try {
    const currentMtime = statSync(storePath).mtimeMs;
    if (currentMtime > lastKnownMtimeMs) {
      log('info', 'Cron jobs.json modified externally, hot-reloading...');
      lastKnownMtimeMs = currentMtime; // Prevent re-triggering on next tick
      const oldIds = new Set(jobStore.jobs.map(j => j.id));
      loadJobs();
      const newIds = new Set(jobStore.jobs.map(j => j.id));
      const added = jobStore.jobs.filter(j => !oldIds.has(j.id)).length;
      const removed = [...oldIds].filter(id => !newIds.has(id)).length;
      if (added || removed) {
        log('info', `Hot-reload: ${added} job(s) added, ${removed} removed. Total: ${jobStore.jobs.length}`);
      }
    }
  } catch { /* stat failed, skip */ }
}

function sanitizeName(name: string): string {
  return name.replace(/[^\w\s-]/g, '').trim().slice(0, 50);
}

// ─── Output Persistence (3.3) ──────────────────────────────────

const MAX_RESULTS_PER_JOB = 7;

function getResultsDir(jobId: string): string {
  const dir = join(storePath, '..', '..', 'cron-results', jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Save job output to data/cron-results/{jobId}/{timestamp}.md */
function saveJobResult(jobId: string, jobName: string, output: string): void {
  try {
    const dir = getResultsDir(jobId);
    const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
    writeFileSync(join(dir, filename), `# ${jobName} — ${new Date().toISOString()}\n\n${output}`);
    pruneJobResults(dir);
  } catch (e) {
    log('error', `Failed to save cron result for ${jobId}: ${e}`);
  }
}

/** Keep only the last N results per job */
function pruneJobResults(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .sort(); // ISO timestamps sort naturally
    while (files.length > MAX_RESULTS_PER_JOB) {
      const oldest = files.shift()!;
      unlinkSync(join(dir, oldest));
    }
  } catch { /* best effort */ }
}

/** Load the latest result from a job for context injection */
function loadLatestResult(jobId: string): string | null {
  try {
    const dir = getResultsDir(jobId);
    const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
    if (files.length === 0) return null;
    return readFileSync(join(dir, files[files.length - 1]), 'utf-8');
  } catch {
    return null;
  }
}

/** Build context from dependent jobs' latest outputs */
function buildJobContext(job: CronJob): string {
  if (!job.contextFromJobs || job.contextFromJobs.length === 0) return '';

  const contexts: string[] = [];
  for (const depJobId of job.contextFromJobs) {
    const result = loadLatestResult(depJobId);
    if (result) {
      contexts.push(`--- Context from job ${depJobId} ---\n${result.slice(0, 2000)}`);
    }
  }

  return contexts.length > 0
    ? `\n\n[Previous job outputs for reference:]\n${contexts.join('\n\n')}\n\n`
    : '';
}
