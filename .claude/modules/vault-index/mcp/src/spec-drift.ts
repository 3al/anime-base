// spec-drift — deterministic backstop for changelog discipline (ledger-protocol §4.1).
//
// Cross-checks each create-skill's machine-readable spec-requirements manifest
// (the managed block in .claude/skills/new-*/SKILL.md) against
// SYSTEM/spec_changelog.yaml. A requirement declared by a skill but absent from
// the changelog is the bug we catch: audits would falsely penalize cards created
// before that requirement existed, because the changelog has no introduced-date
// to exempt them.
//
// Pure logic — no dependency on the note index. Reads skill files and the
// changelog directly from disk so it works regardless of what the index covers
// (skills live under .claude/, outside the indexed note set). Harness-neutral:
// both Claude Code and Opencode reach it identically through the MCP tool.
//
// The spec-requirements block format is the shared contract documented in
// core/lib/spec_requirements.mjs; this is its independent TS reader.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const BEGIN_MARK = 'BEGIN: spec-requirements';
const END_MARK = 'END: spec-requirements';

// Generic create-skills that legitimately carry no kind-specific spec (the
// universal note router). Excluded from the scan so they don't emit a
// permanent missing-manifest WARN on every vault.
const EXCLUDED_SKILLS = new Set(['new-note']);

export interface SpecRequirement {
  requirement: string;
  kind_of: string;
}

export interface SkillManifest {
  skill: string; // skill dir name, e.g. "new-anime"
  path: string; // vault-relative path to SKILL.md
  kind: string | null; // slug declared in the block
  requirements: SpecRequirement[];
  hasBlock: boolean;
  malformed?: string; // reason the block could not be parsed
}

export interface DriftFinding {
  severity: 'ERROR' | 'WARN';
  code: string;
  kind?: string;
  skill?: string;
  requirement?: string;
  message: string;
}

export interface SpecDriftResult {
  findings: DriftFinding[];
  skills_scanned: number;
  skills_with_manifest: number;
  changelog_present: boolean;
  summary: { errors: number; warnings: number };
}

/** Parse the spec-requirements managed block out of a SKILL.md body. */
export function extractManifest(skillMdText: string): {
  kind: string | null;
  requirements: SpecRequirement[];
  malformed?: string;
} | null {
  const beginIdx = skillMdText.indexOf(BEGIN_MARK);
  if (beginIdx === -1) return null;
  const endIdx = skillMdText.indexOf(END_MARK, beginIdx);
  if (endIdx === -1) return null;

  const block = skillMdText.slice(beginIdx, endIdx);
  const fence = block.match(/```ya?ml\s*\r?\n([\s\S]*?)\r?\n```/i);
  if (!fence) {
    return { kind: null, requirements: [], malformed: 'spec-requirements block has no fenced ```yaml body' };
  }

  let doc: unknown;
  try {
    doc = parseYaml(fence[1]);
  } catch (err) {
    return { kind: null, requirements: [], malformed: `YAML parse failed: ${(err as Error).message}` };
  }
  if (!doc || typeof doc !== 'object') {
    return { kind: null, requirements: [], malformed: 'spec-requirements body is not a YAML mapping' };
  }

  const obj = doc as Record<string, unknown>;
  const kind = typeof obj.kind === 'string' ? obj.kind : null;
  const reqsRaw = Array.isArray(obj.requirements) ? obj.requirements : [];
  const requirements: SpecRequirement[] = [];
  for (const item of reqsRaw) {
    if (item && typeof item === 'object' && typeof (item as any).requirement === 'string') {
      requirements.push({
        requirement: (item as any).requirement,
        kind_of: typeof (item as any).kind_of === 'string' ? (item as any).kind_of : 'field',
      });
    }
  }
  return { kind, requirements };
}

/** Scan create-skill SKILL.md files (.claude/skills/new-<kind>/) for manifests. */
export function scanCreateSkills(vaultRoot: string): SkillManifest[] {
  const skillsDir = join(vaultRoot, '.claude', 'skills');
  if (!existsSync(skillsDir)) return [];
  const out: SkillManifest[] = [];
  for (const entry of readdirSync(skillsDir)) {
    if (!entry.startsWith('new-')) continue;
    if (EXCLUDED_SKILLS.has(entry)) continue;
    const dir = join(skillsDir, entry);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const skillMd = join(dir, 'SKILL.md');
    if (!existsSync(skillMd)) continue;

    const text = readFileSync(skillMd, 'utf-8');
    const parsed = extractManifest(text);
    const relPath = `.claude/skills/${entry}/SKILL.md`;
    if (!parsed) {
      out.push({ skill: entry, path: relPath, kind: null, requirements: [], hasBlock: false });
    } else {
      out.push({
        skill: entry,
        path: relPath,
        kind: parsed.kind,
        requirements: parsed.requirements,
        hasBlock: true,
        malformed: parsed.malformed,
      });
    }
  }
  return out;
}

/** Parse SYSTEM/spec_changelog.yaml into kind → set of requirement strings. */
function readChangelog(vaultRoot: string): { present: boolean; byKind: Map<string, Set<string>> } {
  const p = join(vaultRoot, 'SYSTEM', 'spec_changelog.yaml');
  const byKind = new Map<string, Set<string>>();
  if (!existsSync(p)) return { present: false, byKind };
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(p, 'utf-8'));
  } catch {
    return { present: true, byKind }; // present but unparseable → treated as empty
  }
  const kinds = (doc as any)?.kinds;
  if (kinds && typeof kinds === 'object') {
    for (const [slug, entries] of Object.entries(kinds)) {
      const set = new Set<string>();
      if (Array.isArray(entries)) {
        for (const e of entries) {
          if (e && typeof e === 'object' && typeof (e as any).requirement === 'string') {
            set.add((e as any).requirement);
          }
        }
      }
      byKind.set(slug, set);
    }
  }
  return { present: true, byKind };
}

/**
 * Compute drift between create-skill manifests and the changelog.
 *
 * Findings:
 *  - manifest-requirement-without-changelog (ERROR): the load-bearing signal —
 *    skill declares a requirement the changelog never recorded → audits will
 *    misattribute. This is exactly the persona_single_section miss.
 *  - changelog-entry-without-manifest (WARN): orphan/stale changelog entry for a
 *    kind whose manifest no longer lists it (requirement removed or renamed).
 *  - missing-manifest (WARN): create-skill carries no spec-requirements block —
 *    backfill candidate.
 *  - malformed-manifest (ERROR): block present but unparseable.
 *  - kind-mismatch (WARN): block `kind:` disagrees with the new-<slug> dir name.
 */
export function computeSpecDrift(vaultRoot: string): SpecDriftResult {
  const skills = scanCreateSkills(vaultRoot);
  const { present: changelogPresent, byKind } = readChangelog(vaultRoot);
  const findings: DriftFinding[] = [];

  for (const sk of skills) {
    if (!sk.hasBlock) {
      findings.push({
        severity: 'WARN',
        code: 'missing-manifest',
        skill: sk.skill,
        message: `${sk.path} has no spec-requirements block — backfill it so changelog drift can be checked.`,
      });
      continue;
    }
    if (sk.malformed) {
      findings.push({
        severity: 'ERROR',
        code: 'malformed-manifest',
        skill: sk.skill,
        message: `${sk.path}: ${sk.malformed}`,
      });
      continue;
    }

    const dirKind = sk.skill.replace(/^new-/, '');
    if (sk.kind && sk.kind !== dirKind) {
      findings.push({
        severity: 'WARN',
        code: 'kind-mismatch',
        skill: sk.skill,
        kind: sk.kind,
        message: `${sk.path}: block kind "${sk.kind}" does not match skill dir "new-${dirKind}".`,
      });
    }

    const lookupKind = sk.kind || dirKind;
    const changelogReqs = byKind.get(lookupKind) ?? new Set<string>();
    const manifestReqs = new Set(sk.requirements.map((r) => r.requirement));

    for (const r of sk.requirements) {
      if (!changelogReqs.has(r.requirement)) {
        findings.push({
          severity: 'ERROR',
          code: 'manifest-requirement-without-changelog',
          kind: lookupKind,
          skill: sk.skill,
          requirement: r.requirement,
          message:
            `${lookupKind}: requirement "${r.requirement}" (${r.kind_of}) is declared by ${sk.path} ` +
            `but has no entry in SYSTEM/spec_changelog.yaml. Append it with its introduced date — ` +
            `otherwise audits falsely penalize cards created before it (ledger-protocol §4.1).`,
        });
      }
    }

    for (const c of changelogReqs) {
      if (!manifestReqs.has(c)) {
        findings.push({
          severity: 'WARN',
          code: 'changelog-entry-without-manifest',
          kind: lookupKind,
          skill: sk.skill,
          requirement: c,
          message:
            `${lookupKind}: changelog records requirement "${c}" but ${sk.path} no longer declares it ` +
            `(removed/renamed?). Keep the changelog (history is append-only) but reconcile the rename if intentional.`,
        });
      }
    }
  }

  const errors = findings.filter((f) => f.severity === 'ERROR').length;
  const warnings = findings.filter((f) => f.severity === 'WARN').length;
  return {
    findings,
    skills_scanned: skills.length,
    skills_with_manifest: skills.filter((s) => s.hasBlock).length,
    changelog_present: changelogPresent,
    summary: { errors, warnings },
  };
}
