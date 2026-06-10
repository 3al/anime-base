import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeTagHealth } from '../dist/tag-health.js';
import { loadCanon } from '../dist/taxonomy.js';
import { lintNote } from '../dist/lint.js';

// --- helpers --------------------------------------------------------------

function makeRecord(over = {}) {
  return {
    path: 'X.md', name: 'X', mtime: 0, lines: 1,
    type: 'concept', domain: 'd', stability: 'stable', priority: 'high',
    note_kind: null, co_authored: 'm', quality: 'draft',
    created: '2026-01-01', updated: '2026-01-01',
    tags: [], aliases: [], extra: {}, outgoingLinks: [], tableBlocks: [],
    frontmatterError: null,
    ...over,
  };
}

function makeIndex(over = {}) {
  return { canonicalTags: new Set(), attachments: { paths: [], byBasename: {}, byStem: {} }, targetExists: () => true, ...over };
}

const canon = (tags, source = 'yaml') => ({ tags: new Set(tags), source });

// --- ghost / noncanon (deterministic) -------------------------------------

test('tag_health: ghost = canon tags with zero uses', () => {
  const notes = [makeRecord({ path: 'a.md', tags: ['used'] })];
  const r = computeTagHealth(notes, canon(['used', 'lonely']));
  assert.deepEqual(r.ghost, ['lonely']);
  assert.equal(r.summary.ghost, 1);
  assert.equal(r.canon_unreliable, false); // yaml source
});

test('tag_health: noncanon_summary = used tags absent from canon', () => {
  const notes = [makeRecord({ path: 'a.md', tags: ['known', 'rogue'] })];
  const r = computeTagHealth(notes, canon(['known']));
  assert.deepEqual(r.noncanon_summary, ['rogue']);
});

test('tag_health: markdown / none canon → canon_unreliable', () => {
  const notes = [makeRecord({ path: 'a.md', tags: ['x'] })];
  assert.equal(computeTagHealth(notes, canon(['x'], 'markdown')).canon_unreliable, true);
  assert.equal(computeTagHealth(notes, canon([], 'none')).canon_unreliable, true);
});

test('tag_health: SYSTEM/ notes are excluded from usage', () => {
  const notes = [makeRecord({ path: 'SYSTEM/Tag_taxonomy.md', tags: ['meta'] })];
  const r = computeTagHealth(notes, canon(['meta']));
  // 'meta' used only in SYSTEM → counts as a ghost on the content surface
  assert.deepEqual(r.ghost, ['meta']);
  assert.equal(r.summary.used_tags, 0);
});

// --- singletons (heuristic) -----------------------------------------------

test('tag_health: singletons = tags used exactly once', () => {
  const notes = [
    makeRecord({ path: 'a.md', tags: ['common', 'once'] }),
    makeRecord({ path: 'b.md', tags: ['common'] }),
  ];
  const r = computeTagHealth(notes, canon(['common', 'once']));
  assert.deepEqual(r.singletons, ['once']);
});

// --- under-tag-discord (heuristic) ----------------------------------------

// Build a facet group of `size` notes where `present` of them carry `tag`.
function facetGroup(tag, present, size, facet = 'Show', field = 'featured_in') {
  return Array.from({ length: size }, (_, i) =>
    makeRecord({ path: `n${i}.md`, tags: i < present ? [tag] : [], extra: { [field]: facet } }),
  );
}

test('tag_health: any-mode flags a tag a sibling lacks (legacy gap)', () => {
  const notes = [
    makeRecord({ path: 'a.md', tags: ['drama'], extra: { featured_in: 'Show1' } }),
    makeRecord({ path: 'b.md', tags: [], extra: { featured_in: 'Show1' } }),
  ];
  const r = computeTagHealth(notes, canon(['drama']), { tagFacetFields: ['featured_in'], underTagMode: 'any' });
  assert.equal(r.under_tag_discord.length, 1);
  const c = r.under_tag_discord[0];
  assert.equal(c.tag, 'drama');
  assert.equal(c.facet_value, 'Show1');
  assert.deepEqual(c.present_on, ['a.md']);
  assert.deepEqual(c.missing_on, ['b.md']);
  // §6.7 — new fields present on every candidate
  assert.equal(c.group_size, 2);
  assert.equal(c.present_fraction, 0.5);
  assert.equal(typeof c.confidence, 'number');
});

test('tag_health: any-mode respects multi-valued facet intersection', () => {
  const notes = [
    makeRecord({ path: 'a.md', tags: ['epic'], extra: { affiliations: ['S1', 'S2'] } }),
    makeRecord({ path: 'b.md', tags: [], extra: { affiliations: ['S2'] } }),
    makeRecord({ path: 'c.md', tags: [], extra: { affiliations: ['S3'] } }), // no shared facet
  ];
  const r = computeTagHealth(notes, canon(['epic']), { tagFacetFields: ['affiliations'], underTagMode: 'any' });
  // discord only under shared value S2 (a & b); c shares nothing
  const vals = r.under_tag_discord.map((c) => c.facet_value);
  assert.deepEqual(vals, ['S2']);
});

test('tag_health: no discord when every sibling agrees', () => {
  const notes = [
    makeRecord({ path: 'a.md', tags: ['drama'], extra: { featured_in: 'S' } }),
    makeRecord({ path: 'b.md', tags: ['drama'], extra: { featured_in: 'S' } }),
  ];
  const r = computeTagHealth(notes, canon(['drama']), { tagFacetFields: ['featured_in'] });
  assert.equal(r.under_tag_discord.length, 0);
});

// §6.1 — majority cuts minority-tag noise, keeps near-universal gap
test('tag_health: majority cuts minority noise, keeps near-universal gap', () => {
  // group of 8, tag on 1 → minority (0.125) → silent under majority default
  const minority = computeTagHealth(facetGroup('photographer', 1, 8), canon(['photographer']),
    { tagFacetFields: ['featured_in'] });
  assert.equal(minority.under_tag_discord.length, 0);
  // group of 8, tag on 7 (missing=1) → near-universal → flagged
  const near = computeTagHealth(facetGroup('shoujo', 7, 8), canon(['shoujo']),
    { tagFacetFields: ['featured_in'] });
  assert.equal(near.under_tag_discord.length, 1);
  assert.equal(near.under_tag_discord[0].missing_on.length, 1);
});

// §6.2 — maxMissing gate
test('tag_health: majority maxMissing gate', () => {
  // group of 10, tag on 6 (missing=4) at maxMissing 2 (fraction 0.6 passes) → not flagged
  const many = computeTagHealth(facetGroup('t', 6, 10), canon(['t']), { tagFacetFields: ['featured_in'] });
  assert.equal(many.under_tag_discord.length, 0, 'missing=4 > maxMissing 2');
  // group of 10, tag on 8 (missing=2) → flagged
  const few = computeTagHealth(facetGroup('t', 8, 10), canon(['t']), { tagFacetFields: ['featured_in'] });
  assert.equal(few.under_tag_discord.length, 1);
});

// §6.3 — presentFraction boundary inclusive (>=)
test('tag_health: presentFraction boundary inclusive at 0.6', () => {
  // exactly 0.6 (3/5, missing=2) → flagged
  const at = computeTagHealth(facetGroup('t', 3, 5), canon(['t']), { tagFacetFields: ['featured_in'] });
  assert.equal(at.under_tag_discord.length, 1, '0.6 >= 0.6 flags');
  // 0.5 (2/4) → below threshold → silent
  const below = computeTagHealth(facetGroup('t', 2, 4), canon(['t']), { tagFacetFields: ['featured_in'] });
  assert.equal(below.under_tag_discord.length, 0, '0.5 < 0.6 silent');
});

// §6.5 — off mode
test('tag_health: mode=off yields no under-tag, other detectors intact', () => {
  const notes = facetGroup('shoujo', 7, 8); // would flag under majority
  const r = computeTagHealth(notes, canon(['shoujo', 'lonely']),
    { tagFacetFields: ['featured_in'], underTagMode: 'off' });
  assert.equal(r.under_tag_discord.length, 0);
  assert.equal(r.summary.under_tag_discord, 0);
  assert.deepEqual(r.ghost, ['lonely']); // ghost still computed
});

// §6.6 — ranking + truncate; tighter group ranks above wider at equal fraction
test('tag_health: ranks by confidence and truncates by limit', () => {
  const notes = [
    ...facetGroup('a', 3, 4, 'Tight'),                                          // 0.75, size 4
    ...facetGroup('a', 6, 8, 'Wide').map((n, i) => ({ ...n, path: `w${i}.md` })), // 0.75, size 8
  ];
  const r = computeTagHealth(notes, canon(['a']), { tagFacetFields: ['featured_in'], underTagLimit: 1 });
  assert.equal(r.under_tag_discord.length, 1);
  assert.equal(r.summary.under_tag_truncated, 1);
  assert.equal(r.under_tag_discord[0].facet_value, 'Tight', 'tighter group ranks first at equal fraction');
});

// --- canon loader (yaml SSOT, md fallback) --------------------------------

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'canon-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('loadCanon: yaml wins over markdown and carries meta', async () => {
  await withTempDir(async (dir) => {
    const yamlPath = join(dir, 'tag_taxonomy.yaml');
    const mdPath = join(dir, 'Tag_taxonomy.md');
    await writeFile(mdPath, '| `from-md` | x |\n', 'utf-8');
    await writeFile(yamlPath, 'v: 1\ntags:\n  - name: from-yaml\n    group: theme\n    adult_gated: true\n', 'utf-8');
    const r = await loadCanon(yamlPath, mdPath);
    assert.equal(r.source, 'yaml');
    assert.ok(r.tags.has('from-yaml'));
    assert.ok(!r.tags.has('from-md'));
    assert.equal(r.meta.get('from-yaml').group, 'theme');
    assert.equal(r.meta.get('from-yaml').adult_gated, true);
  });
});

test('loadCanon: falls back to markdown when yaml absent', async () => {
  await withTempDir(async (dir) => {
    const yamlPath = join(dir, 'tag_taxonomy.yaml'); // not created
    const mdPath = join(dir, 'Tag_taxonomy.md');
    await writeFile(mdPath, '| `theme-a` | desc |\n| `theme-b` | desc |\n', 'utf-8');
    const r = await loadCanon(yamlPath, mdPath);
    assert.equal(r.source, 'markdown');
    assert.deepEqual([...r.tags].sort(), ['theme-a', 'theme-b']);
  });
});

test('loadCanon: neither file → source none, empty', async () => {
  await withTempDir(async (dir) => {
    const r = await loadCanon(join(dir, 'nope.yaml'), join(dir, 'nope.md'));
    assert.equal(r.source, 'none');
    assert.equal(r.tags.size, 0);
  });
});

test('loadCanon: present-but-empty yaml → source yaml, empty set', async () => {
  await withTempDir(async (dir) => {
    const yamlPath = join(dir, 'tag_taxonomy.yaml');
    await writeFile(yamlPath, 'v: 1\ntags: []\n', 'utf-8');
    const r = await loadCanon(yamlPath, join(dir, 'absent.md'));
    assert.equal(r.source, 'yaml');
    assert.equal(r.tags.size, 0);
  });
});

// --- maxTags (manifest knob, fixes the 8↔10 drift) ------------------------

test('too-many-tags: default ceiling is 10, not 8', () => {
  const nine = makeRecord({ tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'] });
  const issues = lintNote(nine, makeIndex({ canonicalTags: new Set(nine.tags) }));
  assert.equal(issues.filter((i) => i.code === 'too-many-tags').length, 0, '9 tags is fine at default 10');

  const eleven = makeRecord({ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) });
  const issues2 = lintNote(eleven, makeIndex({ canonicalTags: new Set(eleven.tags) }));
  assert.equal(issues2.filter((i) => i.code === 'too-many-tags').length, 1, '11 tags trips default 10');
});

test('too-many-tags: maxTags knob overrides the default', () => {
  const six = makeRecord({ tags: ['a', 'b', 'c', 'd', 'e', 'f'] });
  const issues = lintNote(six, makeIndex({ canonicalTags: new Set(six.tags) }), { rules: { maxTags: 5 } });
  assert.equal(issues.filter((i) => i.code === 'too-many-tags').length, 1, '6 tags trips override 5');
});
