import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lintNote } from '../dist/lint.js';
import { parseNote } from '../dist/parser.js';
import { lintContent } from '../dist/content-lint.js';

// --- helpers --------------------------------------------------------------

/** Minimal NoteRecord with clean defaults (passes the early frontmatter gates). */
function makeRecord(over = {}) {
  return {
    path: 'X.md', name: 'X', mtime: 0, lines: 1,
    type: 'concept', domain: 'd', stability: 'stable', priority: 'high',
    note_kind: null, co_authored: 'some-model', quality: 'draft',
    created: '2026-01-01', updated: '2026-01-01',
    tags: [], aliases: [], extra: {}, outgoingLinks: [], tableBlocks: [],
    frontmatterError: null,
    ...over,
  };
}

/** Fake VaultIndex carrying only what lintNote touches. `targetExists` defaults
 * to always-true so existing tests see no broken links; broken-link tests pass a
 * predicate over the set of notes that resolve. */
function makeIndex(attachments = { paths: [], byBasename: {}, byStem: {} }, targetExists = () => true) {
  return { canonicalTags: new Set(), attachments, targetExists };
}

const codes = (issues) => issues.map((i) => i.code);
const byCode = (issues, code) => issues.filter((i) => i.code === code);

const FM = '---\ntype: concept\ndomain: d\nstability: stable\npriority: high\n---\n\n';

async function withTempNote(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'vidx-'));
  try {
    const abs = join(dir, 'Card.md');
    // Prepend frontmatter so lintNote passes the no-frontmatter gate and reaches
    // the table checks (the parser computes tableBlocks regardless).
    await writeFile(abs, FM + content, 'utf-8');
    const record = await parseNote(abs, 'Card.md', 0);
    return await fn(record);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- broken-table-row (structural, always-on) -----------------------------

test('broken-table-row: unescaped | inside [[link]] leaks a column', async () => {
  const body = [
    '| A | B |',
    '| --- | --- |',
    '| [[Foo|bar]] | x |', // unescaped pipe → 3 cells vs header 2
  ].join('\n');
  await withTempNote(body, (rec) => {
    const issues = lintNote(rec, makeIndex());
    const hit = byCode(issues, 'broken-table-row');
    assert.equal(hit.length, 1, 'should flag the broken row');
    assert.equal(hit[0].severity, 'ERROR');
    assert.equal(hit[0].class, 'structural');
  });
});

test('broken-table-row: escaped \\| and code-span pipe do NOT trip', async () => {
  const body = [
    '| A | B |',
    '| --- | --- |',
    '| [[Foo\\|bar]] | x |', // escaped pipe → one cell
    '| `a|b` | y |',          // pipe inside inline code → literal
  ].join('\n');
  await withTempNote(body, (rec) => {
    const issues = lintNote(rec, makeIndex());
    assert.equal(byCode(issues, 'broken-table-row').length, 0);
  });
});

test('broken-table-row: bordered vs unbordered rows count alike', async () => {
  const body = [
    '| A | B |',
    '| --- | --- |',
    'a | b', // no border pipes, still 2 cells
  ].join('\n');
  await withTempNote(body, (rec) => {
    assert.equal(byCode(lintNote(rec, makeIndex()), 'broken-table-row').length, 0);
  });
});

// --- cover-ref-mismatch (structural, default-on) --------------------------

test('cover-ref-mismatch: .jpg ref but .jpeg on disk', () => {
  const rec = makeRecord({ extra: { images: { cover: 'X_cover.jpg' } } });
  const idx = makeIndex({
    paths: ['attachments/X_cover.jpeg'],
    byBasename: { 'x_cover.jpeg': 'attachments/X_cover.jpeg' },
    byStem: { 'x_cover': ['jpeg'] },
  });
  const hit = byCode(lintNote(rec, idx), 'cover-ref-mismatch');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].severity, 'ERROR');
  assert.equal(hit[0].class, 'structural');
});

test('cover-ref-mismatch: exact file present → clean', () => {
  const rec = makeRecord({ extra: { images: { cover: 'X_cover.jpg' } } });
  const idx = makeIndex({
    paths: ['attachments/X_cover.jpg'],
    byBasename: { 'x_cover.jpg': 'attachments/X_cover.jpg' },
    byStem: { 'x_cover': ['jpg'] },
  });
  assert.equal(byCode(lintNote(rec, idx), 'cover-ref-mismatch').length, 0);
});

test('cover-ref-mismatch: also catches body cover-embed via suffix', () => {
  const rec = makeRecord({
    outgoingLinks: [{ target: 'X_cover.png', displayText: null, line: 5, isEmbed: true }],
  });
  const idx = makeIndex({
    paths: ['attachments/X_cover.webp'],
    byBasename: { 'x_cover.webp': 'attachments/X_cover.webp' },
    byStem: { 'x_cover': ['webp'] },
  });
  assert.equal(byCode(lintNote(rec, idx), 'cover-ref-mismatch').length, 1);
});

test('cover-ref-mismatch: coverField null disables the check', () => {
  const rec = makeRecord({ extra: { images: { cover: 'X_cover.jpg' } } });
  const idx = makeIndex({ paths: [], byBasename: {}, byStem: { 'x_cover': ['jpeg'] } });
  assert.equal(byCode(lintNote(rec, idx, { rules: { coverField: null } }), 'cover-ref-mismatch').length, 0);
});

// --- name-surface-mismatch (a) (structural, opt-in) -----------------------

test('name-surface-mismatch: basename diverges from slug(name field)', () => {
  const rec = makeRecord({ name: 'Katteya_Bodler', note_kind: 'character', extra: { name_romaji: 'Cattleya Baudelaire' } });
  const opts = { rules: { nameSurfacePairs: [{ kind: 'character', basenameField: 'name_romaji' }] } };
  const hit = byCode(lintNote(rec, makeIndex(), opts), 'name-surface-mismatch');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].class, 'structural');
  assert.equal(hit[0].severity, 'WARN');
});

test('name-surface-mismatch: basename == slug → clean', () => {
  const rec = makeRecord({ name: 'Cattleya_Baudelaire', note_kind: 'character', extra: { name_romaji: 'Cattleya Baudelaire' } });
  const opts = { rules: { nameSurfacePairs: [{ kind: 'character', basenameField: 'name_romaji' }] } };
  assert.equal(byCode(lintNote(rec, makeIndex(), opts), 'name-surface-mismatch').length, 0);
});

test('name-surface-mismatch: off when no pairs configured (opt-in)', () => {
  const rec = makeRecord({ name: 'Katteya_Bodler', note_kind: 'character', extra: { name_romaji: 'Cattleya Baudelaire' } });
  assert.equal(byCode(lintNote(rec, makeIndex()), 'name-surface-mismatch').length, 0);
});

const NS_OPTS = { rules: { nameSurfacePairs: [{ kind: 'character', basenameField: 'name_romaji' }] } };

test('name-surface-mismatch: Surname_Given order vs natural-order field → clean (F1)', () => {
  const rec = makeRecord({ name: 'Hodgins_Claudia', note_kind: 'character', extra: { name_romaji: 'Claudia Hodgins' } });
  assert.equal(byCode(lintNote(rec, makeIndex(), NS_OPTS), 'name-surface-mismatch').length, 0);
});

test('name-surface-mismatch: extra basename token (title prefix) tolerated (F1)', () => {
  const rec = makeRecord({ name: 'King_Jihl', note_kind: 'character', extra: { name_romaji: 'Jihl' } });
  assert.equal(byCode(lintNote(rec, makeIndex(), NS_OPTS), 'name-surface-mismatch').length, 0);
});

test('name-surface-mismatch: diacritic difference tolerated (F1)', () => {
  const rec = makeRecord({ name: 'Nausicaa', note_kind: 'character', extra: { name_romaji: 'Nausicaä' } });
  assert.equal(byCode(lintNote(rec, makeIndex(), NS_OPTS), 'name-surface-mismatch').length, 0);
});

// --- required-tags-by-kind (theme-leak replacement) -----------------------

test('required-tags-by-kind: NO hardcoded model-card rule remains', () => {
  const rec = makeRecord({ note_kind: 'model-card', tags: [] });
  // Without caller config the former hardcoded neural-model/llm rule must be gone.
  assert.equal(byCode(lintNote(rec, makeIndex()), 'missing-required-tag').length, 0);
});

test('required-tags-by-kind: caller config enforces tags', () => {
  const rec = makeRecord({ note_kind: 'model-card', tags: ['llm'] });
  const opts = { rules: { requiredTagsByKind: [{ kind: 'model-card', tags: ['neural-model', 'llm'] }] } };
  const hit = byCode(lintNote(rec, makeIndex(), opts), 'missing-required-tag');
  assert.equal(hit.length, 1); // missing neural-model only
  assert.equal(hit[0].class, 'structural');
});

// --- user-only-fabricated (heuristic, opt-in, content) --------------------

const UO_CFG = { userOnly: { sections: ['## Личный отзыв'], stubWhitelist: ['Заполните личный отзыв'] } };

test('user-only-fabricated: filled section on model-authored unverified note', () => {
  const rec = makeRecord({ co_authored: 'nemotron', quality: 'draft' });
  const body = '# Card\n\n## Личный отзыв\n\nЭтот гриб произвёл на меня сильное впечатление своей текстурой.\n';
  const hit = byCode(lintContent(rec, body, UO_CFG.userOnly ? { userOnly: UO_CFG.userOnly } : {}), 'user-only-fabricated');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].class, 'heuristic');
});

test('user-only-fabricated: empty stub section → clean', () => {
  const rec = makeRecord({ co_authored: 'nemotron', quality: 'draft' });
  const body = '## Личный отзыв\n\n## Другое\n';
  assert.equal(byCode(lintContent(rec, body, { userOnly: UO_CFG.userOnly }), 'user-only-fabricated').length, 0);
});

test('user-only-fabricated: whitelisted stub phrase → clean', () => {
  const rec = makeRecord({ co_authored: 'nemotron', quality: 'draft' });
  const body = '## Личный отзыв\n\nЗаполните личный отзыв после первого похода.\n';
  assert.equal(byCode(lintContent(rec, body, { userOnly: UO_CFG.userOnly }), 'user-only-fabricated').length, 0);
});

test('user-only-fabricated: verified note is exempt', () => {
  const rec = makeRecord({ co_authored: 'nemotron', quality: 'verified' });
  const body = '## Личный отзыв\n\nНастоящий человеческий отзыв здесь.\n';
  assert.equal(byCode(lintContent(rec, body, { userOnly: UO_CFG.userOnly }), 'user-only-fabricated').length, 0);
});

// --- mixed-script-prose (heuristic, opt-in, content) ----------------------

test('mixed-script-prose: lowercase latin intrusion in cyrillic prose', () => {
  const rec = makeRecord();
  const body = 'Этот персонаж deceased в финале и был хорошим acquaintance героя.';
  const hit = byCode(lintContent(rec, body, { proseScript: 'cyrillic' }), 'mixed-script-prose');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].class, 'heuristic');
  assert.match(hit[0].message, /deceased/);
});

test('mixed-script-prose: foreign diacritics flagged', () => {
  const rec = makeRecord();
  const body = 'Это были častые встречи в саду.';
  assert.equal(byCode(lintContent(rec, body, { proseScript: 'cyrillic' }), 'mixed-script-prose').length, 1);
});

test('mixed-script-prose: capitalized names and styled/linked latin spared', () => {
  const rec = makeRecord();
  const body = 'Персонаж Cattleya дружит с **Violet Evergarden** и [[Gilbert_Bougainvillea]].';
  assert.equal(byCode(lintContent(rec, body, { proseScript: 'cyrillic' }), 'mixed-script-prose').length, 0);
});

test('mixed-script-prose: off without proseScript (opt-in)', () => {
  const rec = makeRecord();
  const body = 'Этот персонаж deceased в финале.';
  assert.equal(byCode(lintContent(rec, body, {}), 'mixed-script-prose').length, 0);
});

test('mixed-script-prose: Obsidian callout marker is not flagged (F2)', () => {
  const rec = makeRecord();
  const body = '> [!warning]- Спойлеры\n> Он погибает в конце сезона.';
  assert.equal(byCode(lintContent(rec, body, { proseScript: 'cyrillic' }), 'mixed-script-prose').length, 0);
});

test('mixed-script-prose: capitalized macron-names spared (F2)', () => {
  const rec = makeRecord();
  const body = 'Режиссёр Itō работал с Satō и Yōji над сценарием.';
  assert.equal(byCode(lintContent(rec, body, { proseScript: 'cyrillic' }), 'mixed-script-prose').length, 0);
});

test('mixed-script-prose: homoglyph typo flagged even if part-cyrillic (F2)', () => {
  const rec = makeRecord();
  const body = 'Это был аркy сюжета и idол поколения.'; // latin chars inside cyrillic words
  const hit = byCode(lintContent(rec, body, { proseScript: 'cyrillic' }), 'mixed-script-prose');
  assert.equal(hit.length, 1);
});

// --- tooling-vocab-in-prose (heuristic, opt-in, content) ------------------

const TV_CFG = {
  toolingVocab: {
    fieldNames: ['featured_in', 'voice_actors', 'images.cover'],
    statePhrases: ['в волте', 'карточк[а-яё]* .{0,12}нет'],
    flagSkillCommands: true,
    stubWhitelist: ['Заполняется пользователем (см. /audit-review)'],
  },
};

test('tooling-vocab-in-prose: frontmatter field-name leaked into prose', () => {
  const rec = makeRecord();
  const body = 'В featured_in зафиксирован только один тайтл, а в voice_actors пусто.';
  const hit = byCode(lintContent(rec, body, TV_CFG), 'tooling-vocab-in-prose');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].class, 'heuristic');
  assert.match(hit[0].message, /featured_in/);
});

test('tooling-vocab-in-prose: vault-state phrase flagged', () => {
  const rec = makeRecord();
  const body = 'Похожих карточек в волте пока нет.';
  assert.equal(byCode(lintContent(rec, body, TV_CFG), 'tooling-vocab-in-prose').length, 1);
});

test('tooling-vocab-in-prose: skill-command token flagged', () => {
  const rec = makeRecord();
  const body = 'Финальная полировка делается через /audit-review вручную.';
  const hit = byCode(lintContent(rec, body, TV_CFG), 'tooling-vocab-in-prose');
  assert.equal(hit.length, 1);
  assert.match(hit[0].message, /\/audit-review/);
});

test('tooling-vocab-in-prose: field name in code span / wikilink is masked', () => {
  const rec = makeRecord();
  const body = 'Поле `featured_in` и ссылка [[featured_in]] не считаются техшумом.';
  assert.equal(byCode(lintContent(rec, body, { toolingVocab: { fieldNames: ['featured_in'], statePhrases: [] } }), 'tooling-vocab-in-prose').length, 0);
});

test('tooling-vocab-in-prose: whitelisted stub phrase spares its skill ref', () => {
  const rec = makeRecord();
  const body = '## Личный отзыв\n\nЗаполняется пользователем (см. /audit-review).';
  assert.equal(byCode(lintContent(rec, body, TV_CFG), 'tooling-vocab-in-prose').length, 0);
});

test('tooling-vocab-in-prose: clean reader prose → 0', () => {
  const rec = makeRecord();
  const body = 'Этот персонаж — генерал армии и старый друг героини, погибший в финале.';
  assert.equal(byCode(lintContent(rec, body, TV_CFG), 'tooling-vocab-in-prose').length, 0);
});

test('tooling-vocab-in-prose: off without config (opt-in)', () => {
  const rec = makeRecord();
  const body = 'В featured_in только один тайтл, карточек в волте нет, см. /audit-review.';
  assert.equal(byCode(lintContent(rec, body, {}), 'tooling-vocab-in-prose').length, 0);
});

test('tooling-vocab-in-prose: malformed state-phrase regex is skipped, not thrown', () => {
  const rec = makeRecord();
  const body = 'Обычная проза без техшума.';
  assert.doesNotThrow(() =>
    lintContent(rec, body, { toolingVocab: { fieldNames: [], statePhrases: ['('] } }));
});

// --- empty-tags (structural, §24 backstop) --------------------------------

test('empty-tags: a note with no tags is flagged WARN structural', () => {
  const rec = makeRecord({ tags: [] });
  const hit = byCode(lintNote(rec, makeIndex()), 'empty-tags');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].class, 'structural');
  assert.equal(hit[0].severity, 'WARN');
});

test('empty-tags: a note with tags is clean', () => {
  const rec = makeRecord({ tags: ['mushroom'] });
  assert.equal(byCode(lintNote(rec, makeIndex()), 'empty-tags').length, 0);
});

test('empty-tags: WARN does not break structural_green semantics (not an ERROR)', () => {
  const rec = makeRecord({ tags: [] });
  const errs = lintNote(rec, makeIndex()).filter((i) => i.class === 'structural' && i.severity === 'ERROR' && i.code === 'empty-tags');
  assert.equal(errs.length, 0);
});

// --- broken-link / duplicate-link (structural, always-on, §30) ------------

const olink = (target, line = 1, isEmbed = false) => ({ target, line, isEmbed });

test('broken-link: WikiLink to a non-existent note → ERROR structural', () => {
  const rec = makeRecord({ outgoingLinks: [olink('Ghost_Card')] });
  const idx = makeIndex(undefined, (t) => t === 'Real_Card');
  const hit = byCode(lintNote(rec, idx), 'broken-link');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].class, 'structural');
  assert.equal(hit[0].severity, 'ERROR');
});

test('broken-link: resolving WikiLink is clean (green)', () => {
  const rec = makeRecord({ outgoingLinks: [olink('Real_Card')] });
  const idx = makeIndex(undefined, (t) => t === 'Real_Card');
  assert.equal(byCode(lintNote(rec, idx), 'broken-link').length, 0);
});

test('broken-link: missing media embed is NOT flagged (attachment, not a note)', () => {
  const rec = makeRecord({ outgoingLinks: [olink('attachments/Gone.jpg', 1, true)] });
  const idx = makeIndex(undefined, () => false); // nothing resolves
  assert.equal(byCode(lintNote(rec, idx), 'broken-link').length, 0);
});

test('broken-link: external URLs out of scope — only resolving WikiLinks → no structural ERROR (§25 contrast)', () => {
  // outgoingLinks holds WikiLinks only; markdown/bare URLs never reach here, so
  // a flapping/anti-bot-403 external link can never flip structural_green.
  const rec = makeRecord({ outgoingLinks: [olink('Real_Card')] });
  const idx = makeIndex(undefined, (t) => t === 'Real_Card');
  const structErr = lintNote(rec, idx).filter((i) => i.class === 'structural' && i.severity === 'ERROR');
  assert.equal(structErr.length, 0);
});

test('duplicate-link: same note target linked twice → ERROR structural', () => {
  const rec = makeRecord({ outgoingLinks: [olink('Dup_Card'), olink('Dup_Card', 5)] });
  const hit = byCode(lintNote(rec, makeIndex()), 'duplicate-link');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].class, 'structural');
  assert.equal(hit[0].severity, 'ERROR');
});

test('duplicate-link: the same media embed twice is NOT flagged (table + gallery is intentional)', () => {
  const rec = makeRecord({ outgoingLinks: [olink('attachments/P.jpg', 1, true), olink('attachments/P.jpg', 9, true)] });
  assert.equal(byCode(lintNote(rec, makeIndex()), 'duplicate-link').length, 0);
});

test('duplicate-link: distinct targets are clean', () => {
  const rec = makeRecord({ outgoingLinks: [olink('A'), olink('B')] });
  assert.equal(byCode(lintNote(rec, makeIndex()), 'duplicate-link').length, 0);
});

test('§30 integration: real parsed markdown — duplicate WikiLink flows through lint', async () => {
  const body = 'See [[Alpha]] and again [[Alpha]].\n\nAlso [[Beta]].';
  await withTempNote(body, (rec) => {
    const issues = lintNote(rec, makeIndex(undefined, () => true)); // all resolve
    assert.equal(byCode(issues, 'duplicate-link').length, 1); // Alpha twice
    assert.equal(byCode(issues, 'broken-link').length, 0);
  });
});

test('§30 integration: real parsed markdown — unresolved WikiLinks flagged broken per occurrence', async () => {
  const body = 'See [[Alpha]] and again [[Alpha]].\n\nAlso [[Beta]].';
  await withTempNote(body, (rec) => {
    const issues = lintNote(rec, makeIndex(undefined, () => false)); // none resolve
    assert.equal(byCode(issues, 'broken-link').length, 3); // Alpha×2 + Beta
    assert.equal(byCode(issues, 'duplicate-link').length, 1); // Alpha still duped
  });
});

// --- class tagging invariant ----------------------------------------------

test('every issue carries a structural|heuristic class', () => {
  const rec = makeRecord({ type: null, domain: null, stability: null, priority: null });
  for (const i of lintNote(rec, makeIndex())) {
    assert.ok(i.class === 'structural' || i.class === 'heuristic', `bad class on ${i.code}`);
  }
});
