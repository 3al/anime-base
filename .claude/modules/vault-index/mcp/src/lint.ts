import type { NoteRecord, LintIssue } from './types.js';
import type { VaultIndex } from './vault-index.js';

// Directories excluded from lint (same as lint-vault.sh)
const LINT_SKIP_PREFIXES = ['SYSTEM/', 'ARTIFACTS/'];

/**
 * Check if a file should be linted (matches lint-vault.sh exclusions).
 */
export function isLintable(record: NoteRecord): boolean {
  for (const prefix of LINT_SKIP_PREFIXES) {
    if (record.path.startsWith(prefix)) return false;
  }
  return true;
}

/**
 * Lint a single note record against vault rules.
 * Reproduces all checks from lint-vault.sh.
 */
export function lintNote(record: NoteRecord, index: VaultIndex): LintIssue[] {
  const issues: LintIssue[] = [];

  // --- No frontmatter ---
  if (
    record.type === null &&
    record.domain === null &&
    record.stability === null &&
    record.priority === null
  ) {
    issues.push({ severity: 'ERROR', code: 'no-frontmatter', message: 'File has no YAML frontmatter' });
    return issues; // No further checks possible
  }

  // --- Required fields ---
  const required = ['type', 'domain', 'stability', 'priority'] as const;
  for (const field of required) {
    if (!record[field]) {
      issues.push({
        severity: 'ERROR',
        code: 'missing-field',
        message: `Required field '${field}' is missing`,
      });
    }
  }

  // --- Recommended fields ---
  const recommended = ['created', 'updated', 'co_authored', 'quality'] as const;
  for (const field of recommended) {
    if (!record[field]) {
      issues.push({
        severity: 'WARN',
        code: 'missing-field',
        message: `Recommended field '${field}' is missing`,
      });
    }
  }

  // --- Invalid values ---
  if (record.priority === 'middle') {
    issues.push({
      severity: 'ERROR',
      code: 'invalid-value',
      message: "priority: middle should be 'medium'",
    });
  }

  // --- Tags ---
  if (record.tags.length > 8) {
    issues.push({
      severity: 'ERROR',
      code: 'too-many-tags',
      message: `Has ${record.tags.length} tags (max 8)`,
    });
  }

  // Non-canonical tags
  for (const tag of record.tags) {
    if (!index.canonicalTags.has(tag)) {
      issues.push({
        severity: 'WARN',
        code: 'non-canonical-tag',
        message: tag,
      });
    }
  }

  // --- Required tags by note_kind ---
  if (record.note_kind === 'model-card') {
    if (!record.tags.includes('neural-model')) {
      issues.push({ severity: 'ERROR', code: 'missing-required-tag', message: "model-card requires tag 'neural-model'" });
    }
    if (!record.tags.includes('llm')) {
      issues.push({ severity: 'ERROR', code: 'missing-required-tag', message: "model-card requires tag 'llm'" });
    }
  }

  if (record.note_kind === 'benchmark') {
    if (!record.tags.includes('benchmark')) {
      issues.push({ severity: 'ERROR', code: 'missing-required-tag', message: "benchmark requires tag 'benchmark'" });
    }
  }

  if (record.note_kind === 'coding-assistant') {
    if (!record.tags.includes('agent')) {
      issues.push({ severity: 'ERROR', code: 'missing-required-tag', message: "coding-assistant requires tag 'agent'" });
    }
    if (!record.tags.includes('coding')) {
      issues.push({ severity: 'ERROR', code: 'missing-required-tag', message: "coding-assistant requires tag 'coding'" });
    }
    if (!record.tags.includes('cli')) {
      issues.push({ severity: 'ERROR', code: 'missing-required-tag', message: "coding-assistant requires tag 'cli'" });
    }
  }

  // --- Links ---
  // Count only navigation WikiLinks `[[...]]`, not media embeds `![[...]]`.
  const linkCount = record.outgoingLinks.filter(l => !l.isEmbed).length;
  if (linkCount === 0) {
    issues.push({ severity: 'WARN', code: 'no-outgoing-links', message: 'No outgoing WikiLinks' });
  }
  if (linkCount > 15) {
    issues.push({ severity: 'WARN', code: 'too-many-links', message: `Has ${linkCount} outgoing WikiLinks (max 15)` });
  }

  return issues;
}
