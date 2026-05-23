import { z } from 'zod';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';

const IMAGE_TYPES = ['top', 'bottom', 'side', 'cross-section', 'stem', 'habitat', 'spore-print'] as const;

export function registerImageStatusTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_image_status',
    'Get the current image status for a mushroom card: which view types exist, which are missing, file paths.',
    {
      note: z.string().describe('Note name or path.'),
    },
    async ({ note }) => {
      await index.ensureFresh();

      const record = index.resolve(note);
      if (!record) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Note "${note}" not found.` }) }] };
      }

      if (record.note_kind !== 'mushroom-card') {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Note "${record.name}" is not a mushroom-card (note_kind: ${record.note_kind ?? 'not set'}).` }) }] };
      }

      const images: Record<string, unknown> = (record.extra.images as Record<string, unknown>) ?? {};

      const status: Array<{ type: string; found: boolean; path: string | null; fileExists: boolean }> = [];

      for (const imageType of IMAGE_TYPES) {
        const path = typeof images[imageType] === 'string' ? (images[imageType] as string) : null;
        let fileExists = false;

        if (path) {
          try {
            await stat(join(index.vaultRoot, path));
            fileExists = true;
          } catch {
            fileExists = false;
          }
        }

        status.push({
          type: imageType,
          found: path !== null,
          path,
          fileExists,
        });
      }

      const found = status.filter(s => s.found && s.fileExists);
      const missing = status.filter(s => !s.found);
      const broken = status.filter(s => s.found && !s.fileExists);

      const result = {
        note: record.name,
        path: record.path,
        images: status,
        summary: {
          total: IMAGE_TYPES.length,
          found: found.length,
          missing: missing.length,
          broken: broken.length,
          missingTypes: missing.map(s => s.type),
          brokenTypes: broken.map(s => s.type),
        },
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
