import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { parseNote } from './parser.js';
import { getCanonicalTags } from './taxonomy.js';
import type { NoteRecord, IndexData } from './types.js';

const INDEX_VERSION = 2;

// Directories to skip entirely during scanning
const SKIP_DIRS = new Set(['.claude', '.opencode', '.obsidian', '.git', 'node_modules']);

// Files to skip
const SKIP_FILES = new Set(['CLAUDE.md', 'MEMORY.md']);

export class VaultIndex {
  readonly vaultRoot: string;
  readonly indexPath: string;
  readonly taxonomyPath: string;

  // PRIMARY store: relative path → NoteRecord (source of truth)
  notesByPath = new Map<string, NoteRecord>();

  // Lookup index: name (without .md) → array of records (usually 1; >1 on collision)
  notesByName = new Map<string, NoteRecord[]>();

  // Reverse link index: target name → set of source PATHS
  backlinks = new Map<string, Set<string>>();

  // Alias → canonical note name
  aliasToName = new Map<string, string>();

  // Canonical tags from Tag_taxonomy.md
  canonicalTags = new Set<string>();

  private initialized = false;

  constructor(vaultRoot: string) {
    this.vaultRoot = vaultRoot;
    this.indexPath = join(vaultRoot, '.claude', 'mcp-server', 'index.json');
    this.taxonomyPath = join(vaultRoot, 'SYSTEM', 'Tag_taxonomy.md');
  }

  /**
   * Ensure index is fresh before any query.
   */
  async ensureFresh(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
      this.initialized = true;
    } else {
      await this.refresh();
    }
  }

  /**
   * Force full rebuild from scratch.
   */
  async rebuild(): Promise<{ indexed: number; timeMs: number; added: number; updated: number; removed: number }> {
    const start = Date.now();
    const oldCount = this.notesByPath.size;

    this.notesByPath.clear();
    this.notesByName.clear();
    this.backlinks.clear();
    this.aliasToName.clear();

    const files = await this.walkVault();
    for (const { absolutePath, relativePath } of files) {
      try {
        const st = await stat(absolutePath);
        const record = await parseNote(absolutePath, relativePath, st.mtimeMs);
        this.addRecord(record);
      } catch {
        // Skip unparseable files
      }
    }

    this.rebuildDerivedMaps();
    this.canonicalTags = await getCanonicalTags(this.taxonomyPath);
    await this.persist();

    const timeMs = Date.now() - start;
    return {
      indexed: this.notesByPath.size,
      timeMs,
      added: this.notesByPath.size,
      updated: 0,
      removed: oldCount,
    };
  }

  /**
   * Iterate all notes (source of truth).
   */
  allNotes(): IterableIterator<NoteRecord> {
    return this.notesByPath.values();
  }

  /**
   * Total number of indexed notes.
   */
  get size(): number {
    return this.notesByPath.size;
  }

  /**
   * Resolve a note name or path to a NoteRecord.
   * Tries: exact path, exact name, name without .md, alias, case-insensitive.
   */
  resolve(nameOrPath: string): NoteRecord | undefined {
    // Exact path match (with .md)
    const byPath = this.notesByPath.get(nameOrPath);
    if (byPath) return byPath;

    // Path without .md extension
    const byPathWithExt = this.notesByPath.get(nameOrPath + '.md');
    if (byPathWithExt) return byPathWithExt;

    // Exact name match (returns first if collision)
    const byName = this.notesByName.get(nameOrPath);
    if (byName?.length) return byName[0];

    // Strip .md extension from name
    const withoutExt = nameOrPath.replace(/\.md$/, '');
    const byNameNoExt = this.notesByName.get(withoutExt);
    if (byNameNoExt?.length) return byNameNoExt[0];

    // Alias match
    const canonical = this.aliasToName.get(nameOrPath);
    if (canonical) {
      const records = this.notesByName.get(canonical);
      if (records?.length) return records[0];
    }

    // Case-insensitive fallback
    const lower = withoutExt.toLowerCase();
    for (const [name, records] of this.notesByName) {
      if (name.toLowerCase() === lower && records.length) return records[0];
    }

    return undefined;
  }

  /**
   * Check if a WikiLink target exists (as note name or alias).
   */
  targetExists(target: string): boolean {
    return this.notesByName.has(target) || this.aliasToName.has(target);
  }

  /**
   * Get backlinks for a note (who links to it). Returns set of source PATHS.
   */
  getBacklinks(noteName: string): Set<string> {
    return this.backlinks.get(noteName) ?? new Set();
  }

  /**
   * Get the NoteRecord for a given path.
   */
  getByPath(path: string): NoteRecord | undefined {
    return this.notesByPath.get(path);
  }

  // --- Private methods ---

  private async initialize(): Promise<void> {
    const loaded = await this.loadFromDisk();
    if (loaded) {
      await this.refresh();
    } else {
      await this.rebuild();
    }
  }

  private async loadFromDisk(): Promise<boolean> {
    try {
      const raw = await readFile(this.indexPath, 'utf-8');
      const data: IndexData = JSON.parse(raw);

      if (data.version !== INDEX_VERSION) return false;

      for (const record of data.notes) {
        this.addRecord(record);
      }
      this.rebuildDerivedMaps();
      this.canonicalTags = await getCanonicalTags(this.taxonomyPath);
      return true;
    } catch {
      return false;
    }
  }

  private async persist(): Promise<void> {
    const data: IndexData = {
      version: INDEX_VERSION,
      builtAt: new Date().toISOString(),
      notes: Array.from(this.notesByPath.values()),
    };

    try {
      await writeFile(this.indexPath, JSON.stringify(data), 'utf-8');
    } catch (err) {
      console.error('Failed to persist index:', err);
    }
  }

  private async refresh(): Promise<void> {
    const files = await this.walkVault();
    const currentPaths = new Set<string>();
    let changed = false;

    for (const { absolutePath, relativePath } of files) {
      currentPaths.add(relativePath);

      try {
        const st = await stat(absolutePath);
        const existing = this.notesByPath.get(relativePath);

        if (!existing || existing.mtime !== st.mtimeMs) {
          const record = await parseNote(absolutePath, relativePath, st.mtimeMs);

          if (existing) {
            this.removeRecord(existing);
          }
          this.addRecord(record);
          changed = true;
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Remove deleted files
    for (const [path, record] of this.notesByPath) {
      if (!currentPaths.has(path)) {
        this.removeRecord(record);
        changed = true;
      }
    }

    if (changed) {
      this.rebuildDerivedMaps();
      await this.persist();
    }

    this.canonicalTags = await getCanonicalTags(this.taxonomyPath);
  }

  private addRecord(record: NoteRecord): void {
    this.notesByPath.set(record.path, record);

    const existing = this.notesByName.get(record.name);
    if (existing) {
      existing.push(record);
    } else {
      this.notesByName.set(record.name, [record]);
    }
  }

  private removeRecord(record: NoteRecord): void {
    this.notesByPath.delete(record.path);

    const arr = this.notesByName.get(record.name);
    if (arr) {
      const idx = arr.findIndex(r => r.path === record.path);
      if (idx !== -1) arr.splice(idx, 1);
      if (arr.length === 0) this.notesByName.delete(record.name);
    }
  }

  private rebuildDerivedMaps(): void {
    this.backlinks.clear();
    this.aliasToName.clear();

    for (const record of this.notesByPath.values()) {
      // Build alias map
      for (const alias of record.aliases) {
        this.aliasToName.set(alias, record.name);
      }

      // Build backlinks: target name → set of source PATHS
      for (const link of record.outgoingLinks) {
        let set = this.backlinks.get(link.target);
        if (!set) {
          set = new Set();
          this.backlinks.set(link.target, set);
        }
        set.add(record.path);
      }
    }
  }

  private async walkVault(): Promise<Array<{ absolutePath: string; relativePath: string }>> {
    const results: Array<{ absolutePath: string; relativePath: string }> = [];
    await this.walkDir(this.vaultRoot, results);
    return results;
  }

  private async walkDir(
    dir: string,
    results: Array<{ absolutePath: string; relativePath: string }>,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await this.walkDir(join(dir, entry.name), results);
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        if (SKIP_FILES.has(entry.name)) continue;
        const absolutePath = join(dir, entry.name);
        const relativePath = relative(this.vaultRoot, absolutePath).replace(/\\/g, '/');
        results.push({ absolutePath, relativePath });
      }
    }
  }
}
