import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';

// Media file extensions — not notes, skip in broken-link checks
const MEDIA_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.pdf', '.mp4', '.mp3', '.wav', '.ogg']);

function isMediaTarget(target: string): boolean {
  const dot = target.lastIndexOf('.');
  if (dot === -1) return false;
  return MEDIA_EXTS.has(target.slice(dot).toLowerCase());
}

export function registerBrokenLinksTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_broken_links',
    'Find WikiLinks pointing to non-existent notes. Replaces find-broken-links.sh.',
    {
      folder: z.string().optional().describe('Restrict scan to a subfolder (e.g. "AI/Models").'),
    },
    async ({ folder }) => {
      await index.ensureFresh();

      const broken: Array<{ file: string; line: number; target: string }> = [];

      for (const record of index.allNotes()) {
        if (folder && !record.path.startsWith(folder.endsWith('/') ? folder : folder + '/')) {
          continue;
        }

        for (const link of record.outgoingLinks) {
          if (isMediaTarget(link.target)) continue;
          if (!index.targetExists(link.target)) {
            broken.push({
              file: record.path,
              line: link.line,
              target: link.target,
            });
          }
        }
      }

      const text = broken.length === 0
        ? 'No broken links found.'
        : JSON.stringify({ broken, count: broken.length }, null, 2);

      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
