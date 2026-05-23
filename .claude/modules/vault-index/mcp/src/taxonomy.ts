import { readFile, stat } from 'node:fs/promises';

const TAG_LINE_RE = /^\|\s*`([^`]+)`/;

let cachedTags: Set<string> | null = null;
let cachedMtime: number = 0;

/**
 * Parse canonical tags from Tag_taxonomy.md.
 * Caches result and only re-parses when file mtime changes.
 */
export async function getCanonicalTags(taxonomyPath: string): Promise<Set<string>> {
  try {
    const st = await stat(taxonomyPath);
    const mtime = st.mtimeMs;

    if (cachedTags && mtime === cachedMtime) {
      return cachedTags;
    }

    const content = await readFile(taxonomyPath, 'utf-8');
    const tags = new Set<string>();

    for (const line of content.split('\n')) {
      const match = TAG_LINE_RE.exec(line);
      if (match) {
        tags.add(match[1]!.trim());
      }
    }

    cachedTags = tags;
    cachedMtime = mtime;
    return tags;
  } catch {
    // If taxonomy file doesn't exist, return empty set
    return cachedTags ?? new Set();
  }
}
