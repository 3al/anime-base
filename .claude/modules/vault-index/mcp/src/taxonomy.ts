import { readFile, stat } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

const TAG_LINE_RE = /^\|\s*`([^`]+)`/;

/** Per-tag metadata from the machine-readable canon (tag_taxonomy.yaml). */
export interface TagMeta {
  group?: string;                 // category | theme | format (informative)
  applies_to_kinds?: string[];    // tag is meaningful only for these note_kinds
  adult_gated?: boolean;          // tag sits behind the vault's adult gate
}

/**
 * Result of loading the tag canon. `source` records WHERE the canon came from —
 * 'yaml' is the authoritative machine store (stable, ~0 FP, eligible for future
 * ERROR-gating of noncanon); 'markdown' is the legacy human-table fallback,
 * fragile to format drift (a card-skill breaking a table row poisons the parse)
 * → canon-dependent ERROR-gating MUST stay off when source==='markdown'.
 * 'none' means neither file exists (canon-dependent detectors simply yield empty).
 */
export interface CanonResult {
  tags: Set<string>;
  meta: Map<string, TagMeta>;
  source: 'yaml' | 'markdown' | 'none';
}

let cached: CanonResult | null = null;
let cachedKey = '';

const EMPTY: CanonResult = { tags: new Set(), meta: new Map(), source: 'none' };

/**
 * Load the canonical tag set. yaml (`SYSTEM/tag_taxonomy.yaml`) is the SSOT and
 * wins whenever it exists; otherwise the legacy markdown table is parsed for
 * backward compatibility during the rollout. Cached and only re-read when the
 * relevant file's mtime changes (keyed by which source is authoritative + mtime).
 */
export async function loadCanon(yamlPath: string, mdPath: string): Promise<CanonResult> {
  let yamlMtime = 0;
  let yamlExists = false;
  try {
    yamlMtime = (await stat(yamlPath)).mtimeMs;
    yamlExists = true;
  } catch {
    // yaml absent → fall back to markdown
  }

  let mdMtime = 0;
  if (!yamlExists) {
    try {
      mdMtime = (await stat(mdPath)).mtimeMs;
    } catch {
      // neither file present
      if (cached && cachedKey === 'none') return cached;
      cached = EMPTY;
      cachedKey = 'none';
      return cached;
    }
  }

  // Key includes the authoritative path (not just mtime): one process indexes a
  // single vault, but tests reuse this module-level cache across temp paths.
  const key = yamlExists ? `y:${yamlPath}:${yamlMtime}` : `m:${mdPath}:${mdMtime}`;
  if (cached && key === cachedKey) return cached;

  const result = yamlExists ? await parseYamlCanon(yamlPath) : await parseMarkdownCanon(mdPath);
  cached = result;
  cachedKey = key;
  return result;
}

/** Parse the machine-readable canon. Present-but-unparseable → empty (don't crash);
 * source stays 'yaml' so the operator sees they must fix it, not silently fall back. */
async function parseYamlCanon(path: string): Promise<CanonResult> {
  const tags = new Set<string>();
  const meta = new Map<string, TagMeta>();
  try {
    const doc = parseYaml(await readFile(path, 'utf-8'));
    const arr = (doc as any)?.tags;
    if (Array.isArray(arr)) {
      for (const t of arr) {
        if (!t || typeof t !== 'object' || typeof (t as any).name !== 'string') continue;
        const name = (t as any).name.trim();
        if (!name) continue;
        tags.add(name);
        meta.set(name, {
          group: typeof (t as any).group === 'string' ? (t as any).group : undefined,
          applies_to_kinds: Array.isArray((t as any).applies_to_kinds)
            ? (t as any).applies_to_kinds.filter((k: unknown) => typeof k === 'string')
            : undefined,
          adult_gated: typeof (t as any).adult_gated === 'boolean' ? (t as any).adult_gated : undefined,
        });
      }
    }
  } catch {
    // unparseable yaml → empty canon (source still 'yaml')
  }
  return { tags, meta, source: 'yaml' };
}

/** Legacy fallback: parse backtick-wrapped tags from the first column of the
 * Tag_taxonomy.md tables. Fragile to table-format drift — kept only for the
 * rollout window before a vault has seeded tag_taxonomy.yaml. */
async function parseMarkdownCanon(path: string): Promise<CanonResult> {
  const tags = new Set<string>();
  try {
    const content = await readFile(path, 'utf-8');
    for (const line of content.split('\n')) {
      const match = TAG_LINE_RE.exec(line);
      if (match) tags.add(match[1]!.trim());
    }
  } catch {
    return { tags, meta: new Map(), source: 'none' };
  }
  return { tags, meta: new Map(), source: 'markdown' };
}
