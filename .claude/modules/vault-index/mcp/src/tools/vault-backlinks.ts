import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';

export function registerBacklinksTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_backlinks',
    'Find all notes that link to a given note (reverse link lookup).',
    {
      note: z.string().describe('Note name or path to find backlinks for.'),
    },
    async ({ note }) => {
      await index.ensureFresh();

      const resolved = index.resolve(note);
      const targetName = resolved?.name ?? note.replace(/\.md$/, '');

      const sourcePaths = index.getBacklinks(targetName);
      const backlinks: Array<{ source: string; sourcePath: string; line: number; displayText: string | null }> = [];

      for (const sourcePath of sourcePaths) {
        const sourceRecord = index.getByPath(sourcePath);
        if (!sourceRecord) continue;

        for (const link of sourceRecord.outgoingLinks) {
          if (link.target === targetName) {
            backlinks.push({
              source: sourceRecord.name,
              sourcePath: sourceRecord.path,
              line: link.line,
              displayText: link.displayText,
            });
          }
        }
      }

      const text = backlinks.length === 0
        ? `No backlinks found for "${targetName}".`
        : JSON.stringify({ note: targetName, backlinks, count: backlinks.length }, null, 2);

      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
