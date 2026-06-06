export interface WikiLink {
  target: string;
  displayText: string | null;
  line: number;
  isEmbed: boolean;
}

/**
 * One row of a markdown table, reduced to its structural shape.
 * `cells` is the count of columns produced by splitting the raw row on
 * UNESCAPED `|` (so a correctly escaped `[[A\|B]]` counts as one cell, but a
 * raw `[[A|B]]` leaks an extra column — the broken-table-row defect).
 * Policy-free: the parser records the shape; lint decides what is "broken".
 */
export interface TableRow {
  line: number;   // 1-based source line
  cells: number;  // column count after unescaped-pipe split
}

/**
 * A contiguous markdown table block (header + delimiter + body rows).
 * `headerCells` is the column count of the header row; body rows whose `cells`
 * differ from it render misaligned. Purely structural — no theme knowledge.
 */
export interface TableBlock {
  headerLine: number;   // 1-based line of the header row
  headerCells: number;
  rows: TableRow[];     // body rows (delimiter row excluded)
}

export interface NoteRecord {
  path: string;           // relative: "AI/Models/Claude_Sonnet_4.6.md"
  name: string;           // "Claude_Sonnet_4.6"
  mtime: number;          // file mtime in ms
  lines: number;

  // Core frontmatter
  type: string | null;
  domain: string | null;
  stability: string | null;
  priority: string | null;
  note_kind: string | null;
  co_authored: string | null;
  quality: string | null;
  created: string | null;
  updated: string | null;

  // Arrays
  tags: string[];
  aliases: string[];

  // Specialized frontmatter (model_name, vendor, etc.)
  extra: Record<string, unknown>;

  // Parse diagnostic: set when a `---` block exists but YAML failed to parse
  // (e.g. duplicate key). null when frontmatter is absent or parsed cleanly.
  frontmatterError: string | null;

  // WikiLinks
  outgoingLinks: WikiLink[];

  // Structural skeleton (policy-free, computed at parse time, persisted).
  // Used by the always-on broken-table-row rule without re-reading the file at
  // lint time. Heuristic content rules (user-only-fabricated, mixed-script-prose)
  // need full prose and are served by an on-demand read instead, not from here.
  tableBlocks: TableBlock[];
}

/**
 * Attachment inventory: every non-markdown media file in the vault, indexed for
 * the cover-ref-mismatch rule. Theme-neutral — collected by file extension, not
 * by folder name. `byBasename`/`byStem` keys are lowercased for case-tolerant
 * lookup (Obsidian links are case-insensitive on the basename).
 */
export interface AttachmentInventory {
  paths: string[];                    // relative paths of all media files
  byBasename: Record<string, string>; // "x_cover.jpg" → "attachments/X_cover.jpg"
  byStem: Record<string, string[]>;   // "x_cover" → ["jpeg"] (extensions present)
}

export interface IndexData {
  version: number;
  builtAt: string;
  notes: NoteRecord[];
  attachments: AttachmentInventory;
}

export interface LintIssue {
  severity: 'ERROR' | 'WARN';
  // Issue stream. `structural` issues are deterministic with ~0 false positives
  // — the "dashboard green by structure" signal depends ONLY on these. `heuristic`
  // issues are fuzzy smells (opt-in) kept in a separate stream so their noise
  // never erodes trust in the structural signal. See Roadmap §23.
  class: 'structural' | 'heuristic';
  code: string;
  message: string;
}

export interface LintResult {
  file: string;
  issues: LintIssue[];
  record: NoteRecord;
}
