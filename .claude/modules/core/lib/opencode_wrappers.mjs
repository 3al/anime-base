// Opencode wrapper generator — shared by setup.mjs (bootstrap-entry skills),
// harness-opencode, /harness-agnostic-audit, /add-note-kind. Each writer scans
// <vault>/.claude/skills/*/SKILL.md and emits a thin wrapper at
// <vault>/.opencode/commands/<name>.md.
//
// setup.mjs seeds wrappers for the top-level skills it materializes (init-vault,
// migrate-vault-index) so the framework entry point is slash-invokable in Opencode
// before harness-opencode is ever installed (chicken-and-egg on a fresh vault).
//
// Why a wrapper at all: in Opencode, slash-invocation of a skill performs a
// passive load (SKILL.md dumped to chat, model acknowledges, no execution).
// The wrapper forces active execution via imperative phrasing. Spec:
// docs/Vault_Bootstrap_Architecture.md § Slash UX в Opencode через wrapper commands.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Build the canonical wrapper file body for a skill.
 *
 * @param {string} skillName      — kebab-case skill identifier (= dir name)
 * @param {string} skillDescription — verbatim description from SKILL.md frontmatter
 * @returns {string} full wrapper .md content, ending with newline
 */
export function buildWrapperContent(skillName, skillDescription) {
  const desc = (skillDescription || '').trim();
  return [
    '---',
    'description: >',
    indentForFolded(desc),
    '---',
    `Invoke the \`${skillName}\` skill via the skill tool NOW.`,
    '',
    'User\'s arguments: $ARGUMENTS',
    '',
    'Execute the skill\'s instructions IMMEDIATELY using the arguments above. Do not just acknowledge — perform the actions and report the result.',
    '',
  ].join('\n');
}

/**
 * Format `desc` as a YAML folded-scalar body (2-space indent on each line).
 * Empty input → single indented blank line so the `description: >` block parses.
 */
function indentForFolded(desc) {
  if (!desc) return '  ';
  return desc
    .split(/\r?\n/)
    .map((line) => `  ${line.trimEnd()}`)
    .join('\n');
}

/**
 * Parse the YAML frontmatter of a SKILL.md and return {name, description}.
 * Supports both folded `description: >` and inline `description: "..."`.
 * Returns null if file lacks frontmatter or required fields.
 */
export function parseSkillFrontmatter(filePath) {
  if (!existsSync(filePath)) return null;
  const text = readFileSync(filePath, 'utf-8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = m[1];

  const name = extractScalar(fm, 'name');
  const description = extractDescription(fm);
  if (!name || !description) return null;
  return { name, description };
}

function extractScalar(fm, key) {
  const re = new RegExp(`^${escapeRegex(key)}:\\s*(.+?)\\s*$`, 'm');
  const m = fm.match(re);
  if (!m) return null;
  return stripQuotes(m[1]);
}

/**
 * Extract `description:` value. Handles three YAML forms:
 *   description: simple-scalar
 *   description: "quoted scalar"
 *   description: >        (folded multi-line, ends at next top-level key or EOF)
 *     line one
 *     line two
 */
function extractDescription(fm) {
  const lines = fm.split(/\r?\n/);
  let i = 0;
  for (; i < lines.length; i++) {
    if (/^description:/.test(lines[i])) break;
  }
  if (i >= lines.length) return null;

  const head = lines[i].slice('description:'.length).trim();
  if (head === '>' || head === '>-' || head === '|' || head === '|-') {
    // Folded/literal block — collect indented continuation lines.
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l === '' || /^\s+/.test(l)) {
        body.push(l.replace(/^\s+/, ''));
      } else {
        break;
      }
    }
    // For folded (`>`): join lines with single space, blank lines = paragraph break.
    if (head.startsWith('>')) {
      return body.join(' ').replace(/\s+/g, ' ').trim();
    }
    return body.join('\n').trim();
  }

  // Inline scalar (possibly quoted).
  return stripQuotes(head);
}

/**
 * Walk <vault>/.claude/skills/, return array of {name, description, source_path}
 * for every skill whose SKILL.md parses cleanly. Skipped entries (no SKILL.md
 * or malformed frontmatter) are returned as {name, skipped: 'reason'} so callers
 * can surface them in warnings.
 *
 * @returns {Array<{name, description?, source_path?, skipped?}>}
 */
export function scanVaultSkills(vault_root) {
  const skillsDir = join(vault_root, '.claude/skills');
  if (!existsSync(skillsDir)) return [];

  const results = [];
  for (const entry of readdirSync(skillsDir)) {
    const dir = join(skillsDir, entry);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;

    const skillMd = join(dir, 'SKILL.md');
    if (!existsSync(skillMd)) {
      results.push({ name: entry, skipped: 'no_skill_md' });
      continue;
    }
    const parsed = parseSkillFrontmatter(skillMd);
    if (!parsed) {
      results.push({ name: entry, skipped: 'frontmatter_parse_failed' });
      continue;
    }
    // Trust the directory name as authoritative — frontmatter `name` may drift.
    results.push({
      name: entry,
      description: parsed.description,
      source_path: skillMd,
    });
  }
  return results;
}

function stripQuotes(s) {
  if (s.length >= 2) {
    const first = s[0], last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
