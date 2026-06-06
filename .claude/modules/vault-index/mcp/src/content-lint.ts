import type { NoteRecord, LintIssue } from './types.js';

// Heuristic CONTENT lint rules (Roadmap §23). Unlike the structural rules these
// need the raw prose body, so the caller (vault_lint) reads the file on-demand
// and passes the body in — only when the rule's opt-in config is present. They
// emit `class: 'heuristic'` issues that live in a separate stream from the
// deterministic structural signal (a fuzzy WARN must never break "green by
// structure"). Theme-neutral: section list, stub whitelist, and prose script
// are all parameters supplied by the caller from the vault manifest.

export interface UserOnlyConfig {
  sections: string[];        // exact heading lines, e.g. "## Личный отзыв"
  stubWhitelist?: string[];  // canonical stub phrases the creator seeds
}

export interface ContentRuleConfig {
  userOnly?: UserOnlyConfig;
  proseScript?: string;      // dominant script of vault prose, e.g. "cyrillic"
}

/** Strip the YAML frontmatter block so body rules never scan metadata. */
export function stripFrontmatter(content: string): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return content;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') return lines.slice(i + 1).join('\n');
  }
  return content;
}

/**
 * Run the heuristic content rules against a note body. `body` is the raw file
 * text (frontmatter still attached — stripped here). Returns heuristic issues.
 */
export function lintContent(
  record: NoteRecord,
  body: string,
  config: ContentRuleConfig,
): LintIssue[] {
  const issues: LintIssue[] = [];
  const prose = stripFrontmatter(body);

  if (config.userOnly && config.userOnly.sections.length > 0) {
    issues.push(...userOnlyFabricated(record, prose, config.userOnly));
  }
  if (config.proseScript) {
    issues.push(...mixedScriptProse(prose, config.proseScript));
  }
  return issues;
}

// --- user-only-fabricated -------------------------------------------------

/**
 * A USER-ONLY prose section (the creator seeds a stub the model must not fill)
 * found NON-stub while the note is model-authored and unverified → probable
 * fabrication. `co_authored` set + `quality != verified` is the model-authored
 * signal; the stub whitelist (canonical creator phrase) suppresses the legit
 * placeholder. Heuristic by nature — we cannot prove a human did not type it.
 */
function userOnlyFabricated(
  record: NoteRecord,
  prose: string,
  cfg: UserOnlyConfig,
): LintIssue[] {
  // Only meaningful for model-authored, not-yet-verified notes.
  const modelAuthored = !!record.co_authored && record.co_authored.trim() !== '';
  const verified = (record.quality ?? '').toLowerCase() === 'verified';
  if (!modelAuthored || verified) return [];

  const issues: LintIssue[] = [];
  const whitelist = (cfg.stubWhitelist ?? []).map((s) => normalize(s));

  for (const heading of cfg.sections) {
    const bodyText = sectionBody(prose, heading);
    if (bodyText === null) continue; // section absent → nothing to judge
    const norm = normalize(bodyText);
    if (norm === '') continue; // empty → a proper stub, fine
    // Whitelisted canonical stub phrase → legitimate placeholder.
    if (whitelist.some((w) => w !== '' && norm.includes(w))) continue;
    issues.push({
      severity: 'WARN',
      class: 'heuristic',
      code: 'user-only-fabricated',
      message: `USER-ONLY section '${heading}' is filled on a model-authored, unverified note — probable fabrication (should be the creator's stub until a human writes it)`,
    });
  }
  return issues;
}

/**
 * Return the body text under an exact heading line, up to the next markdown
 * heading (any level), or null if the heading is absent. Fenced code is left
 * intact — emptiness is what matters here.
 */
function sectionBody(prose: string, heading: string): string | null {
  const lines = prose.split('\n');
  const want = heading.trim();
  let i = lines.findIndex((l) => l.trim() === want);
  if (i === -1) return null;
  const collected: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (/^#{1,6}\s/.test(lines[j]!.trim())) break;
    collected.push(lines[j]!);
  }
  return collected.join('\n');
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// --- mixed-script-prose ---------------------------------------------------

const CYRILLIC = /[Ѐ-ӿ]/;
const LATIN_BASIC = /[A-Za-z]/;
// Latin letters carrying diacritics (Latin-1 Supplement + Extended-A/B blocks).
const LATIN_DIACRITIC = /[À-ɏ]/;

function scriptOf(ch: string): 'cyrillic' | 'latin' | 'other' {
  if (CYRILLIC.test(ch)) return 'cyrillic';
  if (LATIN_BASIC.test(ch) || LATIN_DIACRITIC.test(ch)) return 'latin';
  return 'other';
}

/**
 * Foreign-script intrusions in prose whose dominant script is `proseScript`.
 * Flags: (a) a token mixing two scripts (e.g. Cyrillic + Latin in one word);
 * (b) a foreign-script token carrying diacritics (e.g. Czech `často`); (c) an
 * isolated lowercase foreign word in dominant-script prose (e.g. `deceased`).
 *
 * FP control (Roadmap §23 point 2 — no name lexicon in a neutral framework):
 * code, WikiLinks, bold spans, markdown links and URLs are masked out first,
 * and Capitalized foreign tokens are spared (likely proper names). Opt-in only.
 */
function mixedScriptProse(prose: string, proseScript: string): LintIssue[] {
  const dominant = proseScript.toLowerCase();
  const masked = maskExempt(prose);

  // Tokens = maximal runs of letters (any script) plus combining marks.
  const tokenRe = /[\p{L}̀-ͯ]+/gu;
  const flagged = new Set<string>();
  const tokens = masked.match(tokenRe) ?? [];

  for (const tok of tokens) {
    const scripts = new Set<string>();
    for (const ch of tok) {
      const s = scriptOf(ch);
      if (s !== 'other') scripts.add(s);
    }
    if (scripts.size === 0) continue;

    // (a) mixed scripts within one token (homoglyph) — always suspicious, even
    // Capitalized: `idол`, `аркy`, `манёвpирование` are genuine typos.
    if (scripts.size > 1) {
      flagged.add(tok);
      continue;
    }
    const only = [...scripts][0]!;
    if (only === dominant) continue; // pure dominant-script word — fine

    // Pure foreign-script token. Spare Capitalized tokens FIRST (probable proper
    // names — the unsolved FP class): this must precede the diacritic branch so
    // macron-names like `Itō`/`Satō`/`Yōji` are not flagged by their diacritics.
    if (tok !== tok.toLowerCase()) continue;
    // Lowercase foreign word: diacritics (`často`) or length ≥3 (`deceased`) → intrusion.
    if (LATIN_DIACRITIC.test(tok) || tok.length >= 3) {
      flagged.add(tok);
    }
  }

  if (flagged.size === 0) return [];
  const sample = [...flagged].slice(0, 12);
  return [{
    severity: 'WARN',
    class: 'heuristic',
    code: 'mixed-script-prose',
    message: `Foreign-script intrusions in ${dominant} prose: ${sample.join(', ')}${flagged.size > sample.length ? ` (+${flagged.size - sample.length} more)` : ''}`,
  }];
}

/** Mask spans that legitimately carry foreign script so they are not tokenized. */
function maskExempt(prose: string): string {
  return prose
    // fenced code blocks
    .replace(/```[\s\S]*?```/g, ' ')
    // inline code
    .replace(/`[^`]*`/g, ' ')
    // wikilinks and embeds (whole, incl. display text)
    .replace(/!?\[\[[^\]]*\]\]/g, ' ')
    // Obsidian callout markers: `> [!warning]- Title` — the [!type] is a keyword,
    // not prose; without this the type word ("warning", "info") floods FPs.
    .replace(/\[![^\]]*\][-+]?/g, ' ')
    // markdown links [text](url) — drop both
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    // bare URLs
    .replace(/https?:\/\/\S+/g, ' ')
    // bold / italic emphasis spans (names/titles deliberately styled)
    .replace(/\*\*[^*]+\*\*/g, ' ')
    .replace(/__[^_]+__/g, ' ');
}
