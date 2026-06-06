import { basename, extname } from 'node:path';
import type { NoteRecord, LintIssue, AttachmentInventory } from './types.js';
import type { VaultIndex } from './vault-index.js';
import type { AsymmetricPair } from './asymmetric.js';
import { lintContent, type ContentRuleConfig } from './content-lint.js';

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
 * Per-vault lint policy. Everything theme-specific is a parameter here — lint
 * itself knows no kinds, fields, sections or scripts. The caller (vault_lint)
 * sources these from vault-manifest.yaml and passes them in, exactly like the
 * existing reciprocity_pairs / link_cap contract.
 */
export interface LintRuleConfig {
  // structural (deterministic, ~0 FP)
  coverField?: string | null;      // dot-path to the cover frontmatter value; default 'images.cover', null disables
  coverEmbedSuffix?: string;       // basename-stem suffix marking cover embeds; default '_cover'
  nameSurfacePairs?: Array<{ kind: string; basenameField: string }>; // opt-in
  requiredTagsByKind?: Array<{ kind: string; tags: string[] }>;      // opt-in (replaces former hardcode)
  // heuristic (fuzzy, opt-in) — served on-demand via the body, see LintOptions.body
  userOnlySections?: string[];
  userOnlyStubWhitelist?: string[];
  proseScript?: string;
  toolingVocabFieldNames?: string[];     // frontmatter field-names that leak into prose
  toolingVocabStatePhrases?: string[];   // regex sources for vault-state phrases (language-specific)
  toolingVocabFlagSkillCommands?: boolean; // flag /slash-command tokens in prose
}

export interface LintOptions {
  asymByTargetPath?: Map<string, AsymmetricPair[]>;
  asymmetricSeverity?: 'WARN' | 'ERROR';
  linkCap?: number | null;         // undefined → default 15; null → disabled
  rules?: LintRuleConfig;
  body?: string | null;            // raw note text, supplied on-demand only when a heuristic rule is active
}

const DEFAULT_LINK_CAP = 15;
const DEFAULT_COVER_FIELD = 'images.cover';
const DEFAULT_COVER_SUFFIX = '_cover';

/**
 * Lint a single note record against vault rules.
 *
 * The structural checks run over the index alone (no file I/O). The heuristic
 * content checks (user-only-fabricated, mixed-script-prose) run only when the
 * caller supplies both their opt-in config and the raw `body` — keeping fuzzy
 * full-text scanning off the persisted index and out of the default path.
 *
 * Theme-neutral: the caller decides every kind/field/section/script and the
 * link ceiling; lint knows no vault shape. Issues are tagged `structural` or
 * `heuristic` so a noisy heuristic never breaks the "green by structure" signal.
 */
export function lintNote(
  record: NoteRecord,
  index: VaultIndex,
  opts: LintOptions = {},
): LintIssue[] {
  const issues: LintIssue[] = [];
  const rules = opts.rules ?? {};
  const linkCap = opts.linkCap === undefined ? DEFAULT_LINK_CAP : opts.linkCap;

  // --- Malformed frontmatter (block present but YAML failed to parse) ---
  if (record.frontmatterError) {
    issues.push({
      severity: 'ERROR',
      class: 'structural',
      code: 'malformed-frontmatter',
      message: `Frontmatter present but failed to parse: ${record.frontmatterError}`,
    });
    return issues; // Fields are unparsed — no further checks possible
  }

  // --- No frontmatter ---
  if (
    record.type === null &&
    record.domain === null &&
    record.stability === null &&
    record.priority === null
  ) {
    issues.push({ severity: 'ERROR', class: 'structural', code: 'no-frontmatter', message: 'File has no YAML frontmatter' });
    return issues; // No further checks possible
  }

  // --- Required fields ---
  const required = ['type', 'domain', 'stability', 'priority'] as const;
  for (const field of required) {
    if (!record[field]) {
      issues.push({
        severity: 'ERROR',
        class: 'structural',
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
        class: 'structural',
        code: 'missing-field',
        message: `Recommended field '${field}' is missing`,
      });
    }
  }

  // --- Invalid values ---
  if (record.priority === 'middle') {
    issues.push({
      severity: 'ERROR',
      class: 'structural',
      code: 'invalid-value',
      message: "priority: middle should be 'medium'",
    });
  }

  // --- Tags ---
  // Empty tags (§24 backstop): a deterministic, consistent signal so the audit
  // judge no longer penalizes an empty `tags` on one card and misses it on
  // another. WARN, not ERROR — does not gate structural_green (tags are not a
  // hard requirement), but both audit axes consume the structural stream uniformly.
  if (record.tags.length === 0) {
    issues.push({
      severity: 'WARN',
      class: 'structural',
      code: 'empty-tags',
      message: 'Frontmatter has no tags',
    });
  }
  if (record.tags.length > 8) {
    issues.push({
      severity: 'ERROR',
      class: 'structural',
      code: 'too-many-tags',
      message: `Has ${record.tags.length} tags (max 8)`,
    });
  }

  // Non-canonical tags
  for (const tag of record.tags) {
    if (!index.canonicalTags.has(tag)) {
      issues.push({
        severity: 'WARN',
        class: 'structural',
        code: 'non-canonical-tag',
        message: tag,
      });
    }
  }

  // --- Required tags by note_kind (theme-neutral: caller-supplied) ---
  // Replaces the former hardcoded model-card/benchmark/coding-assistant rules
  // (a Knowledge_Base leak from before the framework existed). Vaults now
  // declare required tags per kind in the manifest; absent → no check.
  if (rules.requiredTagsByKind) {
    for (const r of rules.requiredTagsByKind) {
      if (record.note_kind !== r.kind) continue;
      for (const tag of r.tags) {
        if (!record.tags.includes(tag)) {
          issues.push({ severity: 'ERROR', class: 'structural', code: 'missing-required-tag', message: `${r.kind} requires tag '${tag}'` });
        }
      }
    }
  }

  // --- Links ---
  const linkCount = record.outgoingLinks.filter(l => !l.isEmbed).length;
  if (linkCount === 0) {
    issues.push({ severity: 'WARN', class: 'structural', code: 'no-outgoing-links', message: 'No outgoing WikiLinks' });
  }
  if (linkCap !== null && linkCount > linkCap) {
    issues.push({ severity: 'WARN', class: 'structural', code: 'too-many-links', message: `Has ${linkCount} outgoing WikiLinks (max ${linkCap})` });
  }

  // --- broken-table-row (structural, always-on) ---
  // A body row whose column count differs from the header renders misaligned —
  // most often an unescaped `|` inside a `[[link]]` in a cast/comparison table
  // (the link parses, so link tools stay green while the render is broken).
  for (const tb of record.tableBlocks) {
    for (const row of tb.rows) {
      if (row.cells !== tb.headerCells) {
        issues.push({
          severity: 'ERROR',
          class: 'structural',
          code: 'broken-table-row',
          message: `Table row at line ${row.line} has ${row.cells} cells but the header has ${tb.headerCells} (unescaped '|' inside a [[link]]? escape it as '\\|')`,
        });
      }
    }
  }

  // --- cover-ref-mismatch (structural, default-on) ---
  if (rules.coverField !== null) {
    issues.push(...coverRefMismatch(
      record,
      index.attachments,
      rules.coverField ?? DEFAULT_COVER_FIELD,
      rules.coverEmbedSuffix ?? DEFAULT_COVER_SUFFIX,
    ));
  }

  // --- name-surface-mismatch (a) (structural, opt-in) ---
  // The basename must CONTAIN every token of the canonical name field, compared
  // order- and diacritic-insensitively. This tolerates vault conventions the
  // naive slug equality tripped on (Surname_Given vs natural-order name fields,
  // title prefixes like `King_`, diacritics `Nausicaä`↔`Nausicaa`) while still
  // catching genuine transliteration divergence (`Katteya_Bodler` lacks the
  // `cattleya`/`baudelaire` tokens). Extra basename tokens are allowed.
  if (rules.nameSurfacePairs) {
    for (const pair of rules.nameSurfacePairs) {
      if (record.note_kind !== pair.kind) continue;
      const val = dotGet(record.extra, pair.basenameField);
      if (typeof val !== 'string' || val.trim() === '') continue;
      const baseTokens = new Set(record.name.split(/[_\s-]+/).map(normToken).filter(Boolean));
      const fieldTokens = val.trim().split(/[\s-]+/).map(normToken).filter(Boolean);
      const missing = fieldTokens.filter((t) => !baseTokens.has(t));
      if (missing.length > 0) {
        issues.push({
          severity: 'WARN',
          class: 'structural',
          code: 'name-surface-mismatch',
          message: `basename '${record.name}' is missing name token(s) [${missing.join(', ')}] from ${pair.basenameField}='${val}'`,
        });
      }
    }
  }

  // --- Asymmetric reciprocal links (opt-in, only when caller passed pairs) ---
  if (opts.asymByTargetPath) {
    const missing = opts.asymByTargetPath.get(record.path);
    if (missing) {
      for (const p of missing) {
        issues.push({
          severity: opts.asymmetricSeverity ?? 'WARN',
          class: 'structural',
          code: 'asymmetric-link',
          message: `Missing reverse WikiLink to ${p.source} (${p.source} links here, not reciprocated)`,
        });
      }
    }
  }

  // --- Heuristic content rules (opt-in, on-demand body) ---
  if (opts.body != null) {
    const contentCfg: ContentRuleConfig = {};
    if (rules.userOnlySections && rules.userOnlySections.length > 0) {
      contentCfg.userOnly = { sections: rules.userOnlySections, stubWhitelist: rules.userOnlyStubWhitelist };
    }
    if (rules.proseScript) contentCfg.proseScript = rules.proseScript;
    const hasFieldNames = !!rules.toolingVocabFieldNames && rules.toolingVocabFieldNames.length > 0;
    const hasStatePhrases = !!rules.toolingVocabStatePhrases && rules.toolingVocabStatePhrases.length > 0;
    if (hasFieldNames || hasStatePhrases || rules.toolingVocabFlagSkillCommands) {
      contentCfg.toolingVocab = {
        fieldNames: rules.toolingVocabFieldNames ?? [],
        statePhrases: rules.toolingVocabStatePhrases ?? [],
        flagSkillCommands: rules.toolingVocabFlagSkillCommands,
        stubWhitelist: rules.userOnlyStubWhitelist,
      };
    }
    if (contentCfg.userOnly || contentCfg.proseScript || contentCfg.toolingVocab) {
      issues.push(...lintContent(record, opts.body, contentCfg));
    }
  }

  return issues;
}

/** Normalize a name token: strip diacritics (NFD), lowercase. Used for the
 * order-insensitive name-surface token comparison. */
function normToken(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Resolve a dot-path (e.g. "images.cover") against a frontmatter object. */
function dotGet(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * cover-ref-mismatch: a cover reference (frontmatter cover field + cover-suffixed
 * body embeds) whose exact file is absent on disk while a same-stem sibling with
 * a different extension exists — the classic `.jpg`↔`.jpeg` poster break. Only
 * the ext-mismatch case is flagged; a wholly-missing file is broken-embed
 * territory, left to a different check to avoid false alarms on drafts.
 */
function coverRefMismatch(
  record: NoteRecord,
  inv: AttachmentInventory,
  coverField: string,
  coverSuffix: string,
): LintIssue[] {
  const refs = new Set<string>();
  const fmCover = dotGet(record.extra, coverField);
  if (typeof fmCover === 'string' && fmCover.trim() !== '') refs.add(fmCover.trim());

  const suffix = coverSuffix.toLowerCase();
  for (const l of record.outgoingLinks) {
    if (!l.isEmbed) continue;
    const b = basename(l.target);
    const ext = extname(b);
    if (ext === '') continue;
    const stem = b.slice(0, b.length - ext.length).toLowerCase();
    if (stem.endsWith(suffix)) refs.add(l.target);
  }

  const out: LintIssue[] = [];
  for (const ref of refs) {
    const lower = basename(ref).toLowerCase();
    if (inv.byBasename[lower]) continue; // exact file present — fine
    const ext = extname(lower).slice(1);
    const stem = lower.slice(0, lower.length - (ext ? ext.length + 1 : 0));
    const present = inv.byStem[stem];
    if (present && present.length > 0) {
      out.push({
        severity: 'ERROR',
        class: 'structural',
        code: 'cover-ref-mismatch',
        message: `Cover reference '${ref}' has no file on disk, but a sibling '.${present[0]}' exists — fix the extension in the reference or rename the file`,
      });
    }
  }
  return out;
}
