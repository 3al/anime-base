import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';

export function registerReindexTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_reindex',
    'Force a full or partial re-index of the vault.',
    {
      full: z.boolean().optional().describe('Force full rebuild (default true).'),
    },
    async ({ full }) => {
      const doFull = full !== false;

      if (doFull) {
        const result = await index.rebuild();
        const text = JSON.stringify({
          action: 'full_rebuild',
          indexed: result.indexed,
          timeMs: result.timeMs,
          changes: { added: result.added, updated: result.updated, removed: result.removed },
        }, null, 2);
        return { content: [{ type: 'text' as const, text }] };
      } else {
        // Just trigger a refresh
        await index.ensureFresh();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ action: 'refresh', indexed: index.size }, null, 2),
          }],
        };
      }
    },
  );
}
