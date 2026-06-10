// tag-health — vault-wide tagging-discipline detectors (TZ §B).
//
// Aggregate hygiene over the whole tag axis, kept OUT of per-card lint because it
// is about the taxonomy, not a single card. Strictly splits deterministic from
// fuzzy (Roadmap §23): `ghost`/`noncanon_summary` are deterministic (~0 FP over a
// stable canon); `singletons`/`under_tag_discord` are heuristic candidates for
// human revision, NOT defects. Nothing here gates structural_green.
//
// Pure logic over a note list + canon snapshot → trivially unit-testable without
// the MCP server or a full VaultIndex (mirrors spec-drift.ts).

import type { NoteRecord } from './types.js';
import { isLintable } from './lint.js';

export interface TagHealthOptions {
  /** Frontmatter field-names that define a "facet" for under-tag-discord
   * (vault-manifest::tag_facet_fields, e.g. featured_in / affiliations). */
  tagFacetFields?: string[];
  /** Cap on under-tag candidates returned (heuristic stream can be large in
   * entity-clustered corpora). Default 200. */
  underTagLimit?: number;
  /** under-tag algorithm selector (vault-manifest::under_tag_mode). Default
   * 'majority' — flag only near-universal tags missing from a few group members
   * (thematic tags are discriminating by nature; "any gap" is an inverted prior
   * → noise). 'any' = legacy behaviour (any gap), for vaults with genuinely
   * group/categorical tags. 'off' = skip under-tag entirely. */
  underTagMode?: 'majority' | 'any' | 'off';
  /** majority: minimum fraction of the group carrying the tag to flag (`>=`,
   * vault-manifest::under_tag_present_fraction). Default 0.6. */
  underTagPresentFraction?: number;
  /** majority: flag only when at most N members miss the tag
   * (vault-manifest::under_tag_max_missing). Default 2. */
  underTagMaxMissing?: number;
}

export interface UnderTagCandidate {
  facet_field: string;
  facet_value: string;
  tag: string;
  present_on: string[];   // note paths in the facet group that carry the tag
  missing_on: string[];   // sibling note paths in the same group that lack it
  group_size: number;        // members.length
  present_fraction: number;  // has.length / members.length
  confidence: number;        // present_fraction × tightness (ranking key)
}

export interface TagHealthResult {
  canon_source: 'yaml' | 'markdown' | 'none';
  // ghost/noncanon are only trustworthy over the yaml SSOT. Over the markdown
  // fallback (fragile) or with no canon at all, they are advisory — flagged so
  // callers (and the future ERROR-gate) don't act on a shaky canon.
  canon_unreliable: boolean;
  canon_size: number;
  ghost: string[];                          // deterministic: canon tags with 0 uses
  noncanon_summary: string[];               // deterministic: used tags absent from canon
  singletons: string[];                     // heuristic: tags used exactly once
  under_tag_discord: UnderTagCandidate[];   // heuristic candidates
  usage_counts: Record<string, number>;
  summary: {
    used_tags: number;
    ghost: number;
    noncanon: number;
    singletons: number;
    under_tag_discord: number;
    under_tag_truncated: number;
  };
}

/** Resolve a dot-path (e.g. "featured_in") against a frontmatter object. */
function dotGet(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Normalize a facet value to an array of non-empty string keys (handles
 * single-valued and multi-valued `affiliations[]` fields alike). */
function facetValues(raw: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (v == null) return;
    const s = String(v).trim();
    if (s) out.push(s);
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else push(raw);
  return out;
}

export function computeTagHealth(
  notes: NoteRecord[],
  canon: { tags: Set<string>; source: 'yaml' | 'markdown' | 'none' },
  opts: TagHealthOptions = {},
): TagHealthResult {
  const lintable = notes.filter(isLintable);

  // --- usage counts over the content surface (excludes SYSTEM/, ARTIFACTS/) ---
  const usage = new Map<string, number>();
  for (const note of lintable) {
    for (const tag of note.tags) {
      usage.set(tag, (usage.get(tag) ?? 0) + 1);
    }
  }

  // --- deterministic: ghost (canon ∖ used), noncanon (used ∖ canon) ---
  const ghost: string[] = [];
  for (const tag of canon.tags) {
    if ((usage.get(tag) ?? 0) === 0) ghost.push(tag);
  }
  const noncanon: string[] = [];
  for (const tag of usage.keys()) {
    if (!canon.tags.has(tag)) noncanon.push(tag);
  }

  // --- heuristic: singletons (used exactly once) ---
  const singletons: string[] = [];
  for (const [tag, count] of usage) {
    if (count === 1) singletons.push(tag);
  }

  // --- heuristic: under-tag-discord over configured facet fields ---
  // Reframed (TZ §32): 'majority' (default) flags only near-universal tags
  // missing from a few members ("forgot to tag"), NOT any gap — facet co-membership
  // (shared featured_in/affiliations) predicts "together in a work", not "thematically
  // alike", and thematic tags are discriminating by nature. 'any' keeps the old
  // any-gap behaviour; 'off' skips. Candidates are collected unfiltered-by-limit,
  // ranked by confidence, then truncated — so the limit keeps the strongest signals.
  const limit = opts.underTagLimit ?? 200;
  const mode = opts.underTagMode ?? 'majority';
  const presentFrac = opts.underTagPresentFraction ?? 0.6;
  const maxMissing = opts.underTagMaxMissing ?? 2;
  let candidates: UnderTagCandidate[] = [];
  let truncated = 0;
  if (mode !== 'off') {
    for (const field of opts.tagFacetFields ?? []) {
      // group note paths by facet value (a note joins every value it carries)
      const groups = new Map<string, NoteRecord[]>();
      for (const note of lintable) {
        for (const val of facetValues(dotGet(note.extra, field))) {
          (groups.get(val) ?? groups.set(val, []).get(val)!).push(note);
        }
      }
      for (const [val, members] of groups) {
        if (members.length < 2) continue; // need siblings to disagree
        // per-tag holders within the group
        const holders = new Map<string, NoteRecord[]>();
        for (const note of members) {
          for (const tag of note.tags) {
            (holders.get(tag) ?? holders.set(tag, []).get(tag)!).push(note);
          }
        }
        for (const [tag, has] of holders) {
          if (has.length === members.length) continue; // everyone has it → consistent
          const missing = members.filter((m) => !m.tags.includes(tag));
          if (has.length === 0 || missing.length === 0) continue;
          const presentFraction = has.length / members.length;
          if (mode === 'majority') {
            if (presentFraction < presentFrac) continue; // tag held by a minority → discriminating, not a miss
            if (missing.length > maxMissing) continue;    // missed by many → norm, not "forgot"
          }
          // tightness: a gap in a tight facet (group of 2) matters more than in a
          // wide cast (group of 12). confidence ranks candidates for the limit cut.
          const tightness = Math.min(1, 2 / members.length);
          candidates.push({
            facet_field: field,
            facet_value: val,
            tag,
            present_on: has.map((n) => n.path),
            missing_on: missing.map((n) => n.path),
            group_size: members.length,
            present_fraction: presentFraction,
            confidence: presentFraction * tightness,
          });
        }
      }
    }
    // rank by confidence desc; tie-break tighter group first, then tag (determinism)
    candidates.sort((a, b) =>
      b.confidence - a.confidence ||
      a.group_size - b.group_size ||
      a.tag.localeCompare(b.tag),
    );
    if (candidates.length > limit) {
      truncated = candidates.length - limit;
      candidates = candidates.slice(0, limit);
    }
  }

  const usage_counts: Record<string, number> = {};
  for (const [tag, count] of [...usage].sort((a, b) => b[1] - a[1])) {
    usage_counts[tag] = count;
  }

  return {
    canon_source: canon.source,
    canon_unreliable: canon.source !== 'yaml',
    canon_size: canon.tags.size,
    ghost: ghost.sort(),
    noncanon_summary: noncanon.sort(),
    singletons: singletons.sort(),
    under_tag_discord: candidates,
    usage_counts,
    summary: {
      used_tags: usage.size,
      ghost: ghost.length,
      noncanon: noncanon.length,
      singletons: singletons.length,
      under_tag_discord: candidates.length,
      under_tag_truncated: truncated,
    },
  };
}
