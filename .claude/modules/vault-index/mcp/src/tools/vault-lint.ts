import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';
import { lintNote, isLintable } from '../lint.js';
import type { LintIssue } from '../types.js';

interface LintFileResult {
  file: string;
  type: string | null;
  domain: string | null;
  stability: string | null;
  priority: string | null;
  note_kind: string | null;
  tags: string[];
  links_out: number;
  embeds: number;
  lines: number;
  created: string | null;
  updated: string | null;
  co_authored: string | null;
  quality: string | null;
  issues: string[];
}

export function registerLintTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_lint',
    'Validate frontmatter, tags, and links. Replaces lint-vault.sh.',
    {
      target: z.string().optional().describe('File name, relative path, or folder. Omit for entire vault.'),
      showAll: z.boolean().optional().describe('Return all files (true) or only files with issues (false, default).'),
    },
    async ({ target, showAll }) => {
      await index.ensureFresh();

      const records = getTargetRecords(index, target);
      const isSingleFile = records.length === 1;
      const results: LintFileResult[] = [];
      let totalErrors = 0;
      let totalWarnings = 0;
      let filesWithIssues = 0;

      for (const record of records) {
        if (!isLintable(record)) continue;

        const issues = lintNote(record, index);
        const errCount = issues.filter(i => i.severity === 'ERROR').length;
        const warnCount = issues.filter(i => i.severity === 'WARN').length;

        totalErrors += errCount;
        totalWarnings += warnCount;
        if (issues.length > 0) filesWithIssues++;

        // Single-file target: always show (like bash script). Batch: respect showAll.
        if (isSingleFile || showAll || issues.length > 0) {
          results.push({
            file: record.path,
            type: record.type,
            domain: record.domain,
            stability: record.stability,
            priority: record.priority,
            note_kind: record.note_kind,
            tags: record.tags,
            links_out: record.outgoingLinks.filter(l => !l.isEmbed).length,
            embeds: record.outgoingLinks.filter(l => l.isEmbed).length,
            lines: record.lines,
            created: record.created,
            updated: record.updated,
            co_authored: record.co_authored,
            quality: record.quality,
            issues: issues.map(formatIssue),
          });
        }
      }

      const summary = {
        total: records.filter(r => isLintable(r)).length,
        with_issues: filesWithIssues,
        errors: totalErrors,
        warnings: totalWarnings,
      };

      const output = { files: results, summary };
      return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }] };
    },
  );
}

function formatIssue(issue: LintIssue): string {
  return `${issue.severity}:${issue.code}:${issue.message}`;
}

function getTargetRecords(index: VaultIndex, target?: string): NoteRecord[] {
  if (!target) {
    return Array.from(index.allNotes());
  }

  // Try single file resolve
  const single = index.resolve(target);
  if (single) return [single];

  // Try folder prefix
  const folder = target.endsWith('/') ? target : target + '/';
  const results: NoteRecord[] = [];
  for (const record of index.allNotes()) {
    if (record.path.startsWith(folder)) {
      results.push(record);
    }
  }
  return results;
}

// Re-export for use by other tools
import type { NoteRecord } from '../types.js';
export { getTargetRecords };
