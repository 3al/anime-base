import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';
import { lintNote, isLintable, type LintRuleConfig } from '../lint.js';
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
    'Validate frontmatter, tags, links, tables, and cover refs. Replaces lint-vault.sh. Issues are tagged structural (deterministic, ~0 FP — the green-by-structure signal) or heuristic (fuzzy, opt-in). All theme-specific policy (kind-pairs, link cap, cover field, name-surface pairs, required tags, USER-ONLY sections, prose script) is passed in from vault-manifest.yaml, never hardcoded. Heuristic content rules (user-only-fabricated, mixed-script-prose) read each file on-demand and run ONLY when their config is supplied.',
    {
      target: z.string().optional().describe('File name, relative path, or folder. Omit for entire vault.'),
      showAll: z.boolean().optional().describe('Return all files (true) or only files with issues (false, default).'),
      reciprocityPairs: z
        .array(z.array(z.string()))
        .optional()
        .describe('Optional list of [sourceKind, targetKind] pairs (from vault-manifest reciprocity_pairs). Adds asymmetric-link issues. Omit to skip.'),
      asymmetricSeverity: z
        .enum(['WARN', 'ERROR'])
        .optional()
        .describe('Severity for asymmetric-link issues (vault-manifest::asymmetry_severity). Default WARN.'),
      linkCap: z
        .union([z.number(), z.null()])
        .optional()
        .describe('Outgoing-WikiLink ceiling (vault-manifest::link_cap). Number overrides; null disables; omit for default 15.'),
      coverField: z
        .union([z.string(), z.null()])
        .optional()
        .describe("Dot-path to the cover frontmatter value for cover-ref-mismatch (vault-manifest::cover_field). Default 'images.cover'; null disables the check."),
      coverEmbedSuffix: z
        .string()
        .optional()
        .describe("Basename-stem suffix marking cover embeds in the body (vault-manifest::cover_embed_suffix). Default '_cover'."),
      nameSurfacePairs: z
        .array(z.object({ kind: z.string(), basenameField: z.string() }))
        .optional()
        .describe('Opt-in name-surface-mismatch config (vault-manifest::name_surface_pairs): for each {kind, basenameField}, the file basename must equal slug(frontmatter[basenameField]).'),
      requiredTagsByKind: z
        .array(z.object({ kind: z.string(), tags: z.array(z.string()) }))
        .optional()
        .describe('Opt-in required-tags-by-kind (vault-manifest::required_tags_by_kind): notes of `kind` must carry every listed tag. Replaces the former hardcoded kind rules.'),
      userOnlySections: z
        .array(z.string())
        .optional()
        .describe('HEURISTIC opt-in (vault-manifest::user_only_sections): exact heading lines (e.g. "## Личный отзыв") that the model must leave as a stub. A non-stub such section on a model-authored, unverified note → user-only-fabricated WARN. Triggers on-demand file reads.'),
      userOnlyStubWhitelist: z
        .array(z.string())
        .optional()
        .describe('Canonical stub phrases (vault-manifest::user_only_stub_whitelist) that suppress user-only-fabricated when present in the section body.'),
      proseScript: z
        .string()
        .optional()
        .describe('HEURISTIC opt-in (vault-manifest::prose_script): dominant script of vault prose, e.g. "cyrillic". Enables mixed-script-prose (foreign-script intrusions). Absent → rule stays silent. Triggers on-demand file reads.'),
    },
    async (params) => {
      await index.ensureFresh();

      // Precompute asymmetric pairs once, indexed by the note that must add the
      // reverse link (the B side). Opt-in: skipped unless caller passes pairs.
      let asymByTargetPath: Map<string, AsymmetricPair[]> | undefined;
      if (params.reciprocityPairs && params.reciprocityPairs.length > 0) {
        const kindPairs = params.reciprocityPairs
          .filter((p) => p.length >= 2)
          .map((p) => [p[0]!, p[1]!] as [string, string]);
        asymByTargetPath = new Map();
        for (const p of computeAsymmetricForPairs(index, kindPairs)) {
          const arr = asymByTargetPath.get(p.targetPath);
          if (arr) arr.push(p);
          else asymByTargetPath.set(p.targetPath, [p]);
        }
      }

      const rules: LintRuleConfig = {
        coverField: params.coverField,
        coverEmbedSuffix: params.coverEmbedSuffix,
        nameSurfacePairs: params.nameSurfacePairs,
        requiredTagsByKind: params.requiredTagsByKind,
        userOnlySections: params.userOnlySections,
        userOnlyStubWhitelist: params.userOnlyStubWhitelist,
        proseScript: params.proseScript,
      };
      // Heuristic content rules need the raw body. Read on-demand only when one
      // of them is actually configured — otherwise lint stays index-only.
      const heuristicActive =
        (params.userOnlySections != null && params.userOnlySections.length > 0) ||
        (params.proseScript != null && params.proseScript !== '');

      const records = getTargetRecords(index, params.target);
      const isSingleFile = records.length === 1;
      const results: LintFileResult[] = [];
      const counts = {
        structural: { errors: 0, warnings: 0 },
        heuristic: { errors: 0, warnings: 0 },
      };
      let filesWithIssues = 0;

      for (const record of records) {
        if (!isLintable(record)) continue;

        let body: string | null = null;
        if (heuristicActive) {
          try {
            body = await readFile(join(index.vaultRoot, record.path), 'utf-8');
          } catch {
            body = null; // unreadable → skip heuristic checks for this note
          }
        }

        const issues = lintNote(record, index, {
          asymByTargetPath,
          asymmetricSeverity: params.asymmetricSeverity ?? 'WARN',
          linkCap: params.linkCap,
          rules,
          body,
        });

        for (const i of issues) {
          const bucket = counts[i.class];
          if (i.severity === 'ERROR') bucket.errors++;
          else bucket.warnings++;
        }
        if (issues.length > 0) filesWithIssues++;

        // Single-file target: always show (like bash script). Batch: respect showAll.
        if (isSingleFile || params.showAll || issues.length > 0) {
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
        // Flat totals (back-compat) plus the per-class split.
        errors: counts.structural.errors + counts.heuristic.errors,
        warnings: counts.structural.warnings + counts.heuristic.warnings,
        structural: counts.structural,
        heuristic: counts.heuristic,
        // The dashboard signal: green iff no structural ERRORs (heuristics excluded).
        structural_green: counts.structural.errors === 0,
      };

      const output = { files: results, summary };
      return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }] };
    },
  );
}

function formatIssue(issue: LintIssue): string {
  return `${issue.severity}:${issue.class}:${issue.code}:${issue.message}`;
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
