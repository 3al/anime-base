import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';

/**
 * Detect notes that share the same basename across different folders.
 *
 * Obsidian resolves `[[WikiLink]]` by basename, ignoring the folder. Two notes
 * with the same file name in different folders make every `[[Name]]` ambiguous
 * and silently break the graph. The create-time guard in /new-<kind> catches
 * this at authoring; this tool is the lint backstop for accumulated debt or
 * notes brought in from outside.
 *
 * Matching is case-insensitive (Obsidian's link resolution is too) and the
 * `.md` extension is dropped. SYSTEM/ is skipped (same as the other lint tools).
 */
export function registerDuplicateBasenamesTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_duplicate_basenames',
    'Find notes sharing the same basename across different folders. Obsidian resolves WikiLinks by basename (folder-agnostic), so duplicate basenames make every [[Name]] ambiguous and silently break the graph. Lint backstop for the create-time uniqueness guard.',
    {
      folder: z.string().optional().describe('Restrict scan to a subfolder.'),
    },
    async ({ folder }) => {
      await index.ensureFresh();

      // Group note paths by case-insensitive basename (sans .md extension).
      const byBasename = new Map<string, { display: string; files: string[] }>();

      for (const record of index.allNotes()) {
        if (record.path.startsWith('SYSTEM/')) continue;

        if (folder && !record.path.startsWith(folder.endsWith('/') ? folder : folder + '/')) {
          continue;
        }

        const fileName = record.path.split('/').pop() ?? record.path;
        const basename = fileName.replace(/\.md$/i, '');
        const key = basename.toLowerCase();

        const entry = byBasename.get(key);
        if (entry) entry.files.push(record.path);
        else byBasename.set(key, { display: basename, files: [record.path] });
      }

      const duplicates: Array<{ basename: string; files: string[] }> = [];
      for (const { display, files } of byBasename.values()) {
        if (files.length > 1) {
          duplicates.push({ basename: display, files: files.sort() });
        }
      }
      duplicates.sort((a, b) => a.basename.localeCompare(b.basename));

      const text = duplicates.length === 0
        ? 'No duplicate basenames found.'
        : JSON.stringify({ duplicates, count: duplicates.length }, null, 2);

      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
