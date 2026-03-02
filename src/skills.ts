import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { log } from './logger.js';

export interface DiscoveredSkill {
  /** Original directory name (e.g. "AlexHormoziPitch") */
  dirName: string;
  /** Display name from SKILL.md frontmatter (e.g. "alex-hormozi-pitch") */
  name: string;
  /** Telegram-safe command name — lowercase, underscores only (e.g. "alexhormozipitch") */
  command: string;
  /** Short description for Telegram command menu (max 256 chars) */
  description: string;
}

const SKILLS_DIR = join(homedir(), '.claude', 'skills');

/** Directories that are PAI infrastructure, not user-invocable skills */
const EXCLUDED = new Set(['CORE', 'PAI']);

/**
 * Scan ~/.claude/skills/ and parse SKILL.md frontmatter from each directory.
 * Returns an array of discovered skills, sorted by command name.
 * Synchronous — ~63 small file reads, <50ms total.
 */
export function discoverSkills(): DiscoveredSkill[] {
  const skills: DiscoveredSkill[] = [];

  let entries: string[];
  try {
    entries = readdirSync(SKILLS_DIR);
  } catch (e) {
    log('warn', `Failed to read skills directory: ${e}`);
    return [];
  }

  for (const entry of entries) {
    if (EXCLUDED.has(entry)) continue;

    const dirPath = join(SKILLS_DIR, entry);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch { continue; }

    const skillMdPath = join(dirPath, 'SKILL.md');
    let content: string;
    try {
      content = readFileSync(skillMdPath, 'utf-8');
    } catch { continue; } // No SKILL.md — skip

    const parsed = parseFrontmatter(content);
    if (!parsed.name || !parsed.description) continue;

    // Normalize command name for Telegram: lowercase, strip hyphens, letters+digits+underscore only
    const command = parsed.name
      .toLowerCase()
      .replace(/-/g, '')
      .replace(/[^a-z0-9_]/g, '');

    if (!command) continue;

    // Clean description: strip "USE WHEN ..." suffix, truncate to 256 chars
    let desc = parsed.description;
    const useWhenIdx = desc.indexOf('USE WHEN');
    if (useWhenIdx > 0) {
      desc = desc.slice(0, useWhenIdx).replace(/[—–\-,.\s]+$/, '');
    }
    // Collapse whitespace (multi-line YAML)
    desc = desc.replace(/\s+/g, ' ').trim();
    if (desc.length > 256) desc = desc.slice(0, 253) + '...';

    skills.push({
      dirName: entry,
      name: parsed.name,
      command,
      description: desc,
    });
  }

  skills.sort((a, b) => a.command.localeCompare(b.command));
  return skills;
}

/** Parse YAML frontmatter (--- delimited) from a SKILL.md file */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const result: { name?: string; description?: string } = {};

  // Parse name (always single-line)
  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  if (nameMatch) result.name = nameMatch[1].trim();

  // Parse description — handles both single-line and multi-line (> folded scalar)
  const descMatch = yaml.match(/^description:\s*(.*)$/m);
  if (descMatch) {
    const firstLine = descMatch[1].trim();
    if (firstLine === '>' || firstLine === '|') {
      // Multi-line: collect indented continuation lines
      const descStart = yaml.indexOf(descMatch[0]) + descMatch[0].length;
      const rest = yaml.slice(descStart);
      const lines: string[] = [];
      for (const line of rest.split('\n')) {
        if (line.match(/^\s+\S/)) {
          lines.push(line.trim());
        } else if (line.trim() === '') {
          lines.push('');
        } else {
          break; // Next YAML key
        }
      }
      result.description = lines.join(' ').trim();
    } else {
      result.description = firstLine;
    }
  }

  return result;
}
