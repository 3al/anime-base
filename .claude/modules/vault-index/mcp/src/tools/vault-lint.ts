import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';
import { lintNote, isLintable } from '../lint.js';
import type { LintIssue } from '../types.js';
import { computeAsymmetricForPairs, type AsymmetricPair } from '../asymmetric.js';

interface LintFileResult {
  file: string;
  type: string | null;
  domain: string | null;
  stability: string | null;
  priority: string | null;
  note_kind: string | null;
  tags: string[];
  links_out: number;
  embeds: number;
  lines: number;
  created: string | null;
  updated: string | null;
  co_authored: string | null;
  quality: string | null;
  issues: string[];
}

export function registerLintTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_lint',
    'Validate frontmatter, tags, and links. Replaces lint-vault.sh. Optionally pass reciprocityPairs (from vault-manifest reciprocity_pairs) to also surface one-directional links as a WARN (code asymmetric-link) on the note missing the reverse link. Optionally pass linkCap (from vault-manifest link_cap) to override the too-many-links threshold, or null to disable that check. Theme-neutral: kind-pairs and the link ceiling are passed in, not hardcoded.',
    {
      target: z.string().optional().describe('File name, relative path, or folder. Omit for entire vault.'),
      showAll: z.boolean().optional().describe('Return all files (true) or only files with issues (false, default).'),
      reciprocityPairs: z
        .array(z.array(z.string()))
        .optional()
        .describe('Optional list of [sourceKind, targetKind] pairs (e.g. [["character","character"]]). When given, lint adds an asymmetric-link issue on each note that is linked by a sourceKind note but does not link back. Omit to skip the check.'),
      asymmetricSeverity: z
        .enum(['WARN', 'ERROR'])
        .optional()
        .describe('Severity for asymmetric-link issues (per-vault policy from vault-manifest.yaml::asymmetry_severity). Default WARN. Only applies when reciprocityPairs is given.'),
      linkCap: z
        .union([z.number(), z.null()])
        .optional()
        .describe('Outgoing-WikiLink ceiling for the too-many-links check (per-vault policy from vault-manifest.yaml::link_cap). A number overrides the threshold; null disables the check (formalized vaults with many structural links by design). Omit for the default cap of 15.'),
    },
    async ({ target, showAll, reciprocityPairs, asymmetricSeverity, linkCap }) => {
      await index.ensureFresh();

      // Precompute asymmetric pairs once, indexed by the note that must add the
      // reverse link (the B side). Opt-in: skipped unless caller passes pairs.
      let asymByTargetPath: Map<string, AsymmetricPair[]> | undefined;
      if (reciprocityPairs && reciprocityPairs.length > 0) {
        const kindPairs = reciprocityPairs
          .filter((p) => p.length >= 2)
          .map((p) => [p[0]!, p[1]!] as [string, string]);
        asymByTargetPath = new Map();
        for (const p of computeAsymmetricForPairs(index, kindPairs)) {
          const arr = asymByTargetPath.get(p.targetPath);
          if (arr) arr.push(p);
          else asymByTargetPath.set(p.targetPath, [p]);
        }
      }

      const records = getTargetRecords(index, target);
      const isSingleFile = records.length === 1;
      const results: LintFileResult[] = [];
      let totalErrors = 0;
      let totalWarnings = 0;
      let filesWithIssues = 0;

      for (const record of records) {
        if (!isLintable(record)) continue;

        // linkCap omitted (undefined) → default 15; explicit null → disabled.
        // Cannot use ?? here: `null ?? 15` would wrongly re-enable the check.
        const issues = lintNote(
          record,
          index,
          asymByTargetPath,
          asymmetricSeverity ?? 'WARN',
          linkCap === undefined ? 15 : linkCap,
        );
        const errCount = issues.filter(i => i.severity === 'ERROR').length;
        const warnCount = issues.filter(i => i.severity === 'WARN').length;

        totalErrors += errCount;
        totalWarnings += warnCount;
        if (issues.length > 0) filesWithIssues++;

        // Single-file target: always show (like bash script). Batch: respect showAll.
        if (isSingleFile || showAll || issues.length > 0) {
          results.push({
            file: record.path,
            type: record.type,
            domain: record.domain,
            stability: record.stability,
            priority: record.priority,
            note_kind: record.note_kind,
            tags: record.tags,
            links_out: record.outgoingLinks.filter(l => !l.isEmbed).length,
            embeds: record.outgoingLinks.filter(l => l.isEmbed).length,
            lines: record.lines,
            created: record.created,
            updated: record.updated,
            co_authored: record.co_authored,
            quality: record.quality,
            issues: issues.map(formatIssue),
          });
        }
      }

      const summary = {
        total: records.filter(r => isLintable(r)).length,
        with_issues: filesWithIssues,
        errors: totalErrors,
        warnings: totalWarnings,
      };

      const output = { files: results, summary };
      return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }] };
    },
  );
}

function formatIssue(issue: LintIssue): string {
  return `${issue.severity}:${issue.code}:${issue.message}`;
}

function getTargetRecords(index: VaultIndex, target?: string): NoteRecord[] {
  if (!target) {
    return Array.from(index.allNotes());
  }

  // Try single file resolve
  const single = index.resolve(target);
  if (single) return [single];

  // Try folder prefix
  const folder = target.endsWith('/') ? target : target + '/';
  const results: NoteRecord[] = [];
  for (const record of index.allNotes()) {
    if (record.path.startsWith(folder)) {
      results.push(record);
    }
  }
  return results;
}

// Re-export for use by other tools
import type { NoteRecord } from '../types.js';
export { getTargetRecords };
