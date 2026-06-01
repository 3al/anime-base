import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';
import { lintNote, isLintable } from '../lint.js';
import { isMediaTarget } from '../links.js';

export function registerStatsTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_stats',
    'Summary statistics for the vault: counts by type, domain, quality, tags, links, issues.',
    {},
    async () => {
      await index.ensureFresh();

      const byType: Record<string, number> = {};
      const byDomain: Record<string, number> = {};
      const byQuality: Record<string, number> = {};
      const byStability: Record<string, number> = {};
      const byNoteKind: Record<string, number> = {};

      let totalLinks = 0;
      let totalTags = 0;
      let totalBrokenLinks = 0;
      let totalOrphans = 0;
      let totalErrors = 0;
      let totalWarnings = 0;
      const nonCanonicalTags = new Set<string>();
      // Notes whose `---` block exists but failed to parse. Surfaced here (a
      // cheap, frequently-run signal) so a degraded note doesn't stay invisible
      // between full vault_lint runs — its fields are null, so it silently drops
      // from kind-aware tools otherwise. Lists paths; note_kind is NOT fabricated.
      const frontmatterErrorFiles: string[] = [];

      for (const record of index.allNotes()) {
        // Counts by field
        if (record.type) byType[record.type] = (byType[record.type] ?? 0) + 1;
        if (record.domain) byDomain[record.domain] = (byDomain[record.domain] ?? 0) + 1;
        if (record.quality) byQuality[record.quality] = (byQuality[record.quality] ?? 0) + 1;
        if (record.stability) byStability[record.stability] = (byStability[record.stability] ?? 0) + 1;
        if (record.note_kind) byNoteKind[record.note_kind] = (byNoteKind[record.note_kind] ?? 0) + 1;

        if (record.frontmatterError) frontmatterErrorFiles.push(record.path);

        totalLinks += record.outgoingLinks.length;
        totalTags += record.tags.length;

        // Broken links — skip media embeds (X_cover.jpg etc. are attachments,
        // not notes), matching vault_broken_links semantics so the two tools agree.
        for (const link of record.outgoingLinks) {
          if (isMediaTarget(link.target)) continue;
          if (!index.targetExists(link.target)) totalBrokenLinks++;
        }

        // Non-canonical tags
        for (const tag of record.tags) {
          if (!index.canonicalTags.has(tag)) nonCanonicalTags.add(tag);
        }

        // Orphan check
        const incoming = index.getBacklinks(record.name);
        if (incoming.size === 0 && !record.path.startsWith('SYSTEM/') && !record.path.startsWith('ARTIFACTS/')) {
          totalOrphans++;
        }

        // Lint issues (only for lintable files)
        if (isLintable(record)) {
          const issues = lintNote(record, index);
          totalErrors += issues.filter(i => i.severity === 'ERROR').length;
          totalWarnings += issues.filter(i => i.severity === 'WARN').length;
        }
      }

      const totalNotes = index.size;
      const stats = {
        totalNotes,
        byType,
        byDomain,
        byQuality,
        byStability,
        byNoteKind,
        totalTags,
        totalLinks,
        avgTagsPerNote: totalNotes ? +(totalTags / totalNotes).toFixed(1) : 0,
        avgLinksPerNote: totalNotes ? +(totalLinks / totalNotes).toFixed(1) : 0,
        totalBrokenLinks,
        totalOrphans,
        canonicalTagCount: index.canonicalTags.size,
        nonCanonicalTagsUsed: Array.from(nonCanonicalTags).sort(),
        frontmatterErrors: { count: frontmatterErrorFiles.length, files: frontmatterErrorFiles },
        lint: { errors: totalErrors, warnings: totalWarnings },
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }] };
    },
  );
}
