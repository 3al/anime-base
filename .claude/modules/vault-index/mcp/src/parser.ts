import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { NoteRecord, WikiLink, TableBlock, TableRow } from './types.js';

const CORE_FIELDS = new Set([
  'type', 'domain', 'stability', 'priority', 'note_kind',
  'co_authored', 'quality', 'created', 'updated',
  'tags', 'aliases',
]);

const WIKILINK_RE = /\[\[([^\]|\\]+?)(?:[|\\|]([^\]]+?))?\]\]/g;

/**
 * Parse a single .md file into a NoteRecord.
 */
export async function parseNote(
  absolutePath: string,
  relativePath: string,
  mtime: number,
): Promise<NoteRecord> {
  const content = await readFile(absolutePath, 'utf-8');
  const name = basename(relativePath, '.md');
  const lines = content.split('\n').length;

  // Extract frontmatter. A `---` block that exists but fails to parse (e.g.
  // duplicate key) yields kind:'error' — captured so lint can flag it instead
  // of silently treating the note as having no frontmatter at all.
  const fmResult = extractFrontmatter(content);
  const fm = fmResult.kind === 'ok' ? fmResult.data : null;
  const frontmatterError = fmResult.kind === 'error' ? fmResult.message : null;

  // Extract WikiLinks (skipping code blocks)
  const outgoingLinks = extractWikiLinks(content);

  // Structural table skeleton (policy-free; lint decides what is "broken")
  const tableBlocks = extractTableBlocks(content);

  // Separate core fields from extra
  const extra: Record<string, unknown> = {};
  if (fm) {
    for (const [key, value] of Object.entries(fm)) {
      if (!CORE_FIELDS.has(key)) {
        extra[key] = value;
      }
    }
  }

  const toStringOrNull = (v: unknown): string | null => {
    if (v == null) return null;
    return String(v);
  };

  const toStringArray = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string') return [v];
    return [];
  };

  return {
    path: relativePath,
    name,
    mtime,
    lines,
    type: toStringOrNull(fm?.type),
    domain: toStringOrNull(fm?.domain),
    stability: toStringOrNull(fm?.stability),
    priority: toStringOrNull(fm?.priority),
    note_kind: toStringOrNull(fm?.note_kind),
    co_authored: toStringOrNull(fm?.co_authored),
    quality: toStringOrNull(fm?.quality),
    created: toStringOrNull(fm?.created),
    updated: toStringOrNull(fm?.updated),
    tags: toStringArray(fm?.tags),
    aliases: toStringArray(fm?.aliases),
    extra,
    outgoingLinks,
    tableBlocks,
    frontmatterError,
  };
}

/**
 * Outcome of frontmatter extraction:
 *  - 'none'  → no `---` block (or an empty/scalar one with no usable fields)
 *  - 'error' → a `---` block exists but YAML parsing threw (e.g. duplicate key)
 *  - 'ok'    → parsed into an object
 * The 'none'/'error' split is what lets lint distinguish a genuinely
 * frontmatter-less file from one whose frontmatter is malformed.
 */
type FrontmatterResult =
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; data: Record<string, unknown> };

function extractFrontmatter(content: string): FrontmatterResult {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return { kind: 'none' };

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) return { kind: 'none' };

  const yamlBlock = lines.slice(1, endIndex).join('\n');
  try {
    const parsed = parseYaml(yamlBlock, { schema: 'failsafe' });
    if (typeof parsed === 'object' && parsed !== null) {
      return { kind: 'ok', data: parsed as Record<string, unknown> };
    }
    // Empty or scalar frontmatter (e.g. `---\n---`) — no usable fields,
    // treat as absent rather than malformed.
    return { kind: 'none' };
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Split a markdown table row into its cells, respecting:
 *  - inline code spans (`` `a|b` ``): pipes inside are literal, masked out first;
 *  - escaped pipes (`\|`): not separators (so `[[A\|B]]` stays one cell);
 *  - optional border pipes: a single leading/trailing empty segment from a
 *    bordering `|` is dropped so bordered and unbordered rows count alike.
 * Returns the trimmed cell strings. Used for both cell-counting and delimiter
 * detection so header and body are measured identically.
 */
function splitTableRow(rawRow: string): string[] {
  // Mask inline code spans: a `|` inside them is literal, not a separator.
  const masked = rawRow.replace(/`[^`]*`/g, '');
  // Split on pipes NOT preceded by a backslash (Node supports lookbehind).
  const segments = masked.split(/(?<!\\)\|/);
  let start = 0;
  let end = segments.length;
  if (segments[0]!.trim() === '') start = 1;            // leading border pipe
  if (end > start && segments[end - 1]!.trim() === '') end -= 1; // trailing border pipe
  return segments.slice(start, end).map((s) => s.trim());
}

/** A line is a table row candidate if it contains an unescaped, non-code pipe. */
function hasUnescapedPipe(line: string): boolean {
  const masked = line.replace(/`[^`]*`/g, '');
  return /(?<!\\)\|/.test(masked);
}

/** GFM delimiter row: every cell is `:?-+:?` (e.g. `---`, `:--:`, `--:`). */
function isDelimiterRow(line: string): boolean {
  if (!hasUnescapedPipe(line) && !/^\s*:?-+:?\s*$/.test(line)) return false;
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c));
}

/**
 * Extract markdown table blocks (header + delimiter + body rows). A block is a
 * pipe-bearing line immediately followed by a GFM delimiter row; body rows run
 * until a non-pipe / blank line. Fenced code blocks are skipped. Purely
 * structural — records each row's column count; the broken-table-row lint rule
 * compares body rows to the header.
 */
function extractTableBlocks(content: string): TableBlock[] {
  const lines = content.split('\n');
  const blocks: TableBlock[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Header candidate: a pipe-bearing line whose next line is a delimiter row.
    const next = lines[i + 1];
    if (!hasUnescapedPipe(line) || next === undefined || !isDelimiterRow(next)) continue;

    const headerCells = splitTableRow(line).length;
    const rows: TableRow[] = [];
    let j = i + 2; // skip header (i) and delimiter (i+1)
    for (; j < lines.length; j++) {
      const bodyLine = lines[j]!;
      if (bodyLine.trim() === '' || !hasUnescapedPipe(bodyLine)) break;
      if (bodyLine.trimStart().startsWith('```')) break;
      rows.push({ line: j + 1, cells: splitTableRow(bodyLine).length });
    }

    blocks.push({ headerLine: i + 1, headerCells, rows });
    i = j - 1; // resume scanning after this block
  }

  return blocks;
}

function extractWikiLinks(content: string): WikiLink[] {
  const links: WikiLink[] = [];
  const lines = content.split('\n');
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Track fenced code blocks
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Remove inline code spans before scanning for WikiLinks
    const cleaned = line.replace(/`[^`]+`/g, '');

    let match: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((match = WIKILINK_RE.exec(cleaned)) !== null) {
      const raw = match[1]!.trim();
      // Skip pure intra-file anchor links like [[#Section]] — they don't reference a note
      if (raw.startsWith('#')) continue;
      // Strip section anchor from cross-file links like [[Note#Section]] → "Note"
      const hashIdx = raw.indexOf('#');
      const target = hashIdx !== -1 ? raw.slice(0, hashIdx).trim() : raw;
      if (!target) continue;
      // Detect image/media embed syntax: `![[target]]` — preceded by `!`
      const matchStart = match.index;
      const isEmbed = matchStart > 0 && cleaned[matchStart - 1] === '!';
      links.push({
        target,
        displayText: match[2]?.trim() ?? null,
        line: i + 1, // 1-based
        isEmbed,
      });
    }
  }

  return links;
}
