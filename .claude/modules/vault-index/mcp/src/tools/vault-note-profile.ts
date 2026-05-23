import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';
import { lintNote } from '../lint.js';

export function registerNoteProfileTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_note_profile',
    'Full metadata, links, backlinks, and lint issues for a single note.',
    {
      note: z.string().describe('Note name or path.'),
    },
    async ({ note }) => {
      await index.ensureFresh();

      const record = index.resolve(note);
      if (!record) {
        return { content: [{ type: 'text' as const, text: `Note not found: "${note}"` }] };
      }

      // Backlinks
      const sourcePaths = index.getBacklinks(record.name);
      const backlinks: Array<{ source: string; sourcePath: string; line: number }> = [];
      for (const sourcePath of sourcePaths) {
        const sourceRecord = index.getByPath(sourcePath);
        if (!sourceRecord) continue;
        for (const link of sourceRecord.outgoingLinks) {
          if (link.target === record.name) {
            backlinks.push({ source: sourceRecord.name, sourcePath: sourceRecord.path, line: link.line });
          }
        }
      }

      // Lint
      const issues = lintNote(record, index);

      const profile = {
        path: record.path,
        name: record.name,
        lines: record.lines,
        type: record.type,
        domain: record.domain,
        stability: record.stability,
        priority: record.priority,
        note_kind: record.note_kind,
        co_authored: record.co_authored,
        quality: record.quality,
        created: record.created,
        updated: record.updated,
        tags: record.tags,
        aliases: record.aliases,
        extra: record.extra,
        outgoingLinks: record.outgoingLinks.map(l => ({
          target: l.target,
          displayText: l.displayText,
          line: l.line,
        })),
        backlinks,
        issues: issues.map(i => `${i.severity}:${i.code}:${i.message}`),
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(profile, null, 2) }] };
    },
  );
}
