export interface WikiLink {
  target: string;
  displayText: string | null;
  line: number;
  isEmbed: boolean;
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
}

export interface IndexData {
  version: number;
  builtAt: string;
  notes: NoteRecord[];
}

export interface LintIssue {
  severity: 'ERROR' | 'WARN';
  code: string;
  message: string;
}

export interface LintResult {
  file: string;
  issues: LintIssue[];
  record: NoteRecord;
}
