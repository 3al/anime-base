import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';

export function registerQueryTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_query',
    'Filter notes by frontmatter fields: core fields (type, domain, tags, quality, …) plus generic where-clauses over ANY frontmatter field (fieldEquals / fieldGte / fieldIn, dot-paths supported). Request extra fields back via `fields`.',
    {
      type: z.string().optional().describe('Filter by type (concept, guide, reference, principle, etc.)'),
      domain: z.string().optional().describe('Filter by domain (ai, python, architecture, etc.)'),
      tags: z.array(z.string()).optional().describe('Notes must have ALL of these tags.'),
      tagsAny: z.array(z.string()).optional().describe('Notes must have ANY of these tags.'),
      quality: z.string().optional().describe('Filter by quality (verified, draft).'),
      stability: z.string().optional().describe('Filter by stability (stable, evolving, experimental).'),
      noteKind: z.string().optional().describe('Filter by note_kind.'),
      hasField: z.string().optional().describe('Note must have this extra field with truthy value (dot-path supported).'),
      fieldEquals: z
        .array(z.object({ field: z.string(), value: z.string() }))
        .optional()
        .describe('Generic where: each {field, value} must match (String(frontmatter[field]) === value). Dot-paths supported (e.g. images.cover). ANDed together.'),
      fieldGte: z
        .array(z.object({ field: z.string(), value: z.union([z.number(), z.string()]) }))
        .optional()
        .describe('Generic where: frontmatter[field] >= value. Numeric compare when both parse as numbers, else lexical (works for YYYY-MM-DD dates). ANDed.'),
      fieldIn: z
        .array(z.object({ field: z.string(), values: z.array(z.string()) }))
        .optional()
        .describe('Generic where: String(frontmatter[field]) must be one of `values`. ANDed.'),
      fields: z
        .array(z.string())
        .optional()
        .describe('Extra frontmatter fields to return in each result under `extra` (dot-paths supported).'),
      malformedFrontmatter: z.boolean().optional().describe('Only notes whose `---` block exists but failed to parse (frontmatterError != null).'),
      folder: z.string().optional().describe('Restrict to a subfolder.'),
      limit: z.number().optional().describe('Max results (default 50).'),
    },
    async (params) => {
      await index.ensureFresh();

      const limit = params.limit ?? 50;
      const results: Array<Record<string, unknown>> = [];

      for (const record of index.allNotes()) {
        if (results.length >= limit) break;

        // Core filters
        if (params.type && record.type !== params.type) continue;
        if (params.domain && record.domain !== params.domain) continue;
        if (params.quality && record.quality !== params.quality) continue;
        if (params.stability && record.stability !== params.stability) continue;
        if (params.noteKind && record.note_kind !== params.noteKind) continue;

        if (params.folder) {
          const prefix = params.folder.endsWith('/') ? params.folder : params.folder + '/';
          if (!record.path.startsWith(prefix)) continue;
        }

        if (params.tags && !params.tags.every(t => record.tags.includes(t))) continue;
        if (params.tagsAny && !params.tagsAny.some(t => record.tags.includes(t))) continue;

        if (params.hasField && !truthy(dotGet(record.extra, params.hasField))) continue;

        // Generic where-clauses over any frontmatter field (dot-path aware).
        if (params.fieldEquals && !params.fieldEquals.every(c => String(dotGet(record.extra, c.field) ?? '') === c.value)) continue;
        if (params.fieldIn && !params.fieldIn.every(c => c.values.includes(String(dotGet(record.extra, c.field) ?? '')))) continue;
        if (params.fieldGte && !params.fieldGte.every(c => gte(dotGet(record.extra, c.field), c.value))) continue;

        if (params.malformedFrontmatter && !record.frontmatterError) continue;

        const row: Record<string, unknown> = {
          path: record.path,
          name: record.name,
          type: record.type,
          domain: record.domain,
          tags: record.tags,
          quality: record.quality,
          note_kind: record.note_kind,
          frontmatter_error: record.frontmatterError,
        };
        if (params.fields && params.fields.length > 0) {
          const extra: Record<string, unknown> = {};
          for (const f of params.fields) extra[f] = dotGet(record.extra, f);
          row.extra = extra;
        }
        results.push(row);
      }

      const text = JSON.stringify({ notes: results, count: results.length }, null, 2);
      return { content: [{ type: 'text' as const, text }] };
    },
  );
}

/** Resolve a dot-path (e.g. "images.cover") against a frontmatter object. */
function dotGet(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function truthy(v: unknown): boolean {
  return v != null && v !== '' && v !== false;
}

/** field >= value: numeric when both parse as numbers, else lexical compare. */
function gte(field: unknown, value: number | string): boolean {
  if (field == null) return false;
  const fs = String(field);
  const fn = Number(fs);
  const vn = Number(value);
  if (!Number.isNaN(fn) && !Number.isNaN(vn)) return fn >= vn;
  return fs >= String(value);
}
