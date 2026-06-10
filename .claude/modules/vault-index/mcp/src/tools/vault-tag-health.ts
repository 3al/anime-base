import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';
import { computeTagHealth } from '../tag-health.js';

/**
 * vault_tag_health — vault-wide tagging-discipline detectors (TZ §B).
 *
 * Aggregate hygiene over the tag axis (NOT per-card lint). Splits deterministic
 * from fuzzy: ghost (canon tags with 0 uses) and noncanon_summary (used tags
 * absent from canon) are deterministic over the yaml SSOT; singletons and
 * under_tag_discord are heuristic candidates for revision, not defects. Nothing
 * here gates structural_green. ghost/noncanon are advisory when canon_unreliable
 * (no yaml SSOT). Canon is read by the server from SYSTEM/tag_taxonomy.yaml.
 */
export function registerTagHealthTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_tag_health',
    'Vault-wide tagging-discipline report. Deterministic (over the yaml canon): ' +
      'ghost (canonical tags used 0 times), noncanon_summary (used tags not in the canon). ' +
      'Heuristic candidates (NOT defects): singletons (tags used exactly once), ' +
      'under_tag_discord — majority-by-default (a near-universal tag missing from a few ' +
      'group members; "any gap" is the legacy mode). Nothing gates structural_green; ' +
      'ghost/noncanon are advisory when canon_unreliable (vault has no SYSTEM/tag_taxonomy.yaml ' +
      'SSOT). Canon is loaded from SYSTEM/tag_taxonomy.yaml; facet fields + under-tag knobs ' +
      'come from the caller (vault-manifest).',
    {
      tagFacetFields: z
        .array(z.string())
        .optional()
        .describe('Frontmatter field-names defining a facet for under-tag-discord (vault-manifest::tag_facet_fields, e.g. ["featured_in","affiliations"]). Multi-valued fields: siblings share a facet when their value sets intersect. Omit to skip under-tag.'),
      underTagLimit: z
        .number()
        .optional()
        .describe('Cap on under-tag-discord candidates returned, after ranking by confidence (default 200). Excess counted in summary.under_tag_truncated.'),
      underTagMode: z
        .enum(['majority', 'any', 'off'])
        .optional()
        .describe('under-tag-discord algorithm: majority (default — flag only when present_fraction≥presentFraction AND missing≤maxMissing; thematic tags are discriminating, so any-gap is noise) | any (legacy any-gap behaviour, for genuinely group/categorical tags) | off (skip). vault-manifest::under_tag_mode.'),
      underTagPresentFraction: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('majority mode: minimum fraction of the group carrying the tag to flag, >= (default 0.6). vault-manifest::under_tag_present_fraction.'),
      underTagMaxMissing: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('majority mode: flag only when at most N members miss the tag (default 2). vault-manifest::under_tag_max_missing.'),
    },
    async (params) => {
      await index.ensureFresh();
      const result = computeTagHealth(
        Array.from(index.allNotes()),
        { tags: index.canonicalTags, source: index.canonSource },
        {
          tagFacetFields: params.tagFacetFields,
          underTagLimit: params.underTagLimit,
          underTagMode: params.underTagMode,
          underTagPresentFraction: params.underTagPresentFraction,
          underTagMaxMissing: params.underTagMaxMissing,
        },
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
