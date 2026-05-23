import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';

export function registerDuplicateLinksTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_duplicate_links',
    'Find duplicate WikiLinks within the same file. Replaces find-duplicate-links.sh.',
    {
      folder: z.string().optional().describe('Restrict scan to a subfolder.'),
    },
    async ({ folder }) => {
      await index.ensureFresh();

      const duplicates: Array<{ file: string; target: string; count: number }> = [];

      for (const record of index.allNotes()) {
        // Skip SYSTEM/ files (same as bash script)
        if (record.path.startsWith('SYSTEM/')) continue;

        if (folder && !record.path.startsWith(folder.endsWith('/') ? folder : folder + '/')) {
          continue;
        }

        // Count occurrences of each target (exclude media embeds — same photo in
        // table and gallery is intentional per mushroom-card template).
        const counts = new Map<string, number>();
        for (const link of record.outgoingLinks) {
          if (link.isEmbed) continue;
          counts.set(link.target, (counts.get(link.target) ?? 0) + 1);
        }

        for (const [target, count] of counts) {
          if (count > 1) {
            duplicates.push({ file: record.path, target, count });
          }
        }
      }

      const text = duplicates.length === 0
        ? 'No duplicate links found.'
        : JSON.stringify({ duplicates, count: duplicates.length }, null, 2);

      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
