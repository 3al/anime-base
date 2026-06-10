import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';

// Framework-managed infra dirs (mirror lint's LINT_SKIP_PREFIXES): never
// knowledge notes, so never orphans. Theme-neutral — same in every vault.
const EXEMPT_PREFIXES = ['SYSTEM/', 'ARTIFACTS/'];

export function registerOrphansTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_orphans',
    'Find notes with zero incoming WikiLinks. Replaces find-orphans.sh. Index/hub notes that legitimately have no backlinks are exempted per-vault via the `exempt` param (vault-manifest::orphan_exempt) — theme-neutral, no note names baked in.',
    {
      folder: z.string().optional().describe('Restrict scan to a subfolder.'),
      exempt: z
        .array(z.string())
        .optional()
        .describe('Note names (basename, no .md) exempt from the orphan check — index/hub pages that legitimately have zero incoming links (vault-manifest::orphan_exempt). Omit for none.'),
    },
    async ({ folder, exempt }) => {
      await index.ensureFresh();

      const exemptNames = new Set(exempt ?? []);
      const orphans: Array<{ file: string; type: string | null; domain: string | null }> = [];

      for (const record of index.allNotes()) {
        // Skip exempt files
        if (exemptNames.has(record.name)) continue;
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
