import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { NoteRecord, WikiLink } from './types.js';

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
