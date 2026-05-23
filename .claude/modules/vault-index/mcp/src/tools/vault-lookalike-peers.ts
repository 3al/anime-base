import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';

export function registerLookalikePeersTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_lookalike_peers',
    'Find all mushroom-card notes that list this note in their lookalikes frontmatter field. Use before building a lookalike table to discover bidirectional relationships not listed in the current note\'s own lookalikes.',
    {
      note: z.string().describe('Note name without .md extension (e.g. "Macrolepiota_Excoriata")'),
    },
    async ({ note }) => {
      await index.ensureFresh();

      const noteName = note.replace(/\.md$/, '');

      const peers: Array<{
        file: string;
        name: string;
        edibility: string | null;
        listed_in_subject: boolean;
      }> = [];

      // Get the subject note's own lookalikes list for cross-referencing
      const subjectRecord = index.resolve(noteName);
      const subjectLookalikes = new Set<string>(
        (Array.isArray(subjectRecord?.extra?.lookalikes)
          ? (subjectRecord!.extra!.lookalikes as unknown[])
          : []
        )
          .filter((l): l is string => typeof l === 'string')
          .map(l => l.replace(/\.md$/, '')),
      );

      for (const record of index.allNotes()) {
        if (record.note_kind !== 'mushroom-card') continue;
        if (record.name === noteName) continue;

        const lookalikes = record.extra?.lookalikes;
        if (!Array.isArray(lookalikes)) continue;

        const found = (lookalikes as unknown[]).some(
          (l): boolean =>
            typeof l === 'string' && l.replace(/\.md$/, '') === noteName,
        );

        if (found) {
          peers.push({
            file: record.path,
            name: record.name,
            edibility: typeof record.extra?.edibility === 'string' ? record.extra.edibility : null,
            listed_in_subject: subjectLookalikes.has(record.name),
          });
        }
      }

      const unlisted = peers.filter(p => !p.listed_in_subject);

      const result = {
        note: noteName,
        peers,
        count: peers.length,
        unlisted_in_subject: unlisted.map(p => p.name),
        summary: peers.length === 0
          ? 'No other mushroom-card notes reference this note as a lookalike.'
          : `${peers.length} note(s) reference "${noteName}" as a lookalike. ${unlisted.length > 0 ? `${unlisted.length} of them are NOT listed in the subject's own lookalikes field: ${unlisted.map(p => p.name).join(', ')}.` : 'All are already listed in the subject\'s lookalikes.'}`,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
