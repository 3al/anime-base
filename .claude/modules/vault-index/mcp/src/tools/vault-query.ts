import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';

export function registerQueryTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_query',
    'Filter notes by frontmatter fields: type, domain, tags, quality, etc.',
    {
      type: z.string().optional().describe('Filter by type (concept, guide, reference, principle, etc.)'),
      domain: z.string().optional().describe('Filter by domain (ai, python, architecture, etc.)'),
      tags: z.array(z.string()).optional().describe('Notes must have ALL of these tags.'),
      tagsAny: z.array(z.string()).optional().describe('Notes must have ANY of these tags.'),
      quality: z.string().optional().describe('Filter by quality (verified, draft).'),
      stability: z.string().optional().describe('Filter by stability (stable, evolving, experimental).'),
      noteKind: z.string().optional().describe('Filter by note_kind (model-card, benchmark, coding-assistant).'),
      hasField: z.string().optional().describe('Note must have this extra field with truthy value.'),
      malformedFrontmatter: z.boolean().optional().describe('Only notes whose `---` block exists but failed to parse (frontmatterError != null). These have note_kind/type = null and silently drop from kind filters.'),
      folder: z.string().optional().describe('Restrict to a subfolder.'),
      limit: z.number().optional().describe('Max results (default 50).'),
    },
    async (params) => {
      await index.ensureFresh();

      const limit = params.limit ?? 50;
      const results: Array<{
        path: string;
        name: string;
        type: string | null;
        domain: string | null;
        tags: string[];
        quality: string | null;
        note_kind: string | null;
        frontmatter_error: string | null;
      }> = [];

      for (const record of index.allNotes()) {
        if (results.length >= limit) break;

        // Apply filters
        if (params.type && record.type !== params.type) continue;
        if (params.domain && record.domain !== params.domain) continue;
        if (params.quality && record.quality !== params.quality) continue;
        if (params.stability && record.stability !== params.stability) continue;
        if (params.noteKind && record.note_kind !== params.noteKind) continue;

        if (params.folder) {
          const prefix = params.folder.endsWith('/') ? params.folder : params.folder + '/';
          if (!record.path.startsWith(prefix)) continue;
        }

        if (params.tags) {
          if (!params.tags.every(t => record.tags.includes(t))) continue;
        }

        if (params.tagsAny) {
          if (!params.tagsAny.some(t => record.tags.includes(t))) continue;
        }

        if (params.hasField) {
          if (!record.extra[params.hasField]) continue;
        }

        if (params.malformedFrontmatter && !record.frontmatterError) continue;

        results.push({
          path: record.path,
          name: record.name,
          type: record.type,
          domain: record.domain,
          tags: record.tags,
          quality: record.quality,
          note_kind: record.note_kind,
          frontmatter_error: record.frontmatterError,
        });
      }

      const text = JSON.stringify({ notes: results, count: results.length }, null, 2);
      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
