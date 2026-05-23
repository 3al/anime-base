import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';

// Index/meta files exempt from orphan check
const EXEMPT_NAMES = new Set(['LLM_Comparison', 'LLM_Benchmarks', 'Coding_Assistants_Comparison']);
const EXEMPT_PREFIXES = ['SYSTEM/', 'ARTIFACTS/'];

export function registerOrphansTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_orphans',
    'Find notes with zero incoming WikiLinks. Replaces find-orphans.sh.',
    {
      folder: z.string().optional().describe('Restrict scan to a subfolder.'),
    },
    async ({ folder }) => {
      await index.ensureFresh();

      const orphans: Array<{ file: string; type: string | null; domain: string | null }> = [];

      for (const record of index.allNotes()) {
        // Skip exempt files
        if (EXEMPT_NAMES.has(record.name)) continue;
        if (EXEMPT_PREFIXES.some(p => record.path.startsWith(p))) continue;

        // Apply folder filter
        if (folder && !record.path.startsWith(folder.endsWith('/') ? folder : folder + '/')) {
          continue;
        }

        const incoming = index.getBacklinks(record.name);
        if (incoming.size === 0) {
          orphans.push({
            file: record.path,
            type: record.type,
            domain: record.domain,
          });
        }
      }

      const text = orphans.length === 0
        ? 'No orphans found.'
        : JSON.stringify({ orphans, count: orphans.length }, null, 2);

      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
