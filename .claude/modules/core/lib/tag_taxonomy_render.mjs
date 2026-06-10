// tag_taxonomy_render — generate the human-readable SYSTEM/Tag_taxonomy.md view
// from the machine SSOT SYSTEM/tag_taxonomy.yaml (tag-discipline contract).
//
// yaml is authoritative; this redraws the grouped tag tables inside the
// <!-- BEGIN: generated-tag-taxonomy --> / <!-- END --> markers, leaving the
// banner and everything outside the markers untouched. Idempotent: writes only
// when the rendered body differs. Keeping the md generated (not hand-edited)
// removes the create-skill markdown-table edits that used to break the taxonomy
// (broken-table-row) — tags are now added as structured yaml entries.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BEGIN = '<!-- BEGIN: generated-tag-taxonomy -->';
const END = '<!-- END: generated-tag-taxonomy -->';

// group key → section heading + order
const GROUPS = [
  ['category', '### Категорийные теги'],
  ['theme', '### Тематические теги'],
  ['format', '### Формат-теги'],
];

/** Escape a table cell: only the column separator `|` (never `_` / `*` — they
 * break WikiLinks/paths and are meaningful markdown). */
function cell(s) {
  return String(s ?? '').replace(/\|/g, '\\|');
}

/** Strip one layer of matching surrounding quotes from a scalar value. */
function unquote(v) {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Read the canon as [{name, group, description}]. Minimal line-based parser over
 * the known tag_taxonomy.yaml shape (a flat list of mappings) — NOT a general
 * YAML parser, mirroring core/lib/spec_requirements.mjs (core ships no deps).
 * Only the fields the md view renders are extracted (name/group/description).
 */
function readCanon(yamlPath) {
  const lines = readFileSync(yamlPath, 'utf-8').split(/\r?\n/);
  const tags = [];
  let inTags = false;
  let cur = null;
  const flush = () => { if (cur && cur.name) tags.push(cur); cur = null; };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    if (/^tags\s*:/.test(line)) { inTags = true; continue; }
    if (!inTags) continue;
    // a non-indented key ends the tags list (e.g. another top-level field)
    if (/^\S/.test(line)) { flush(); inTags = false; continue; }

    const item = line.match(/^\s*-\s*(\w+)\s*:\s*(.*)$/);
    if (item) {
      flush();
      cur = { name: '', group: 'theme', description: '' };
      if (item[1] === 'name') cur.name = unquote(item[2]);
      continue;
    }
    const kv = line.match(/^\s+(\w+)\s*:\s*(.*)$/);
    if (kv && cur) {
      const [, key, val] = kv;
      if (key === 'name') cur.name = unquote(val);
      else if (key === 'group') cur.group = unquote(val) || 'theme';
      else if (key === 'description') cur.description = unquote(val);
    }
  }
  flush();
  return tags;
}

/** Render the grouped tables body (between the markers). */
function renderBody(tags) {
  const out = [];
  for (const [key, heading] of GROUPS) {
    out.push(heading, '');
    out.push('| Тег | Когда использовать |', '| --- | --- |');
    const rows = tags
      .filter((t) => (t.group === key) || (key === 'theme' && !GROUPS.some(([g]) => g === t.group)))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const t of rows) {
      out.push(`| \`${cell(t.name)}\` | ${cell(t.description)} |`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

/**
 * Regenerate SYSTEM/Tag_taxonomy.md from SYSTEM/tag_taxonomy.yaml.
 * @param {string} vaultRoot
 * @returns {{ changed: boolean, action: 'updated'|'noop'|'skipped', reason?: string }}
 */
export function renderTagTaxonomy(vaultRoot) {
  const yamlPath = join(vaultRoot, 'SYSTEM', 'tag_taxonomy.yaml');
  const mdPath = join(vaultRoot, 'SYSTEM', 'Tag_taxonomy.md');
  if (!existsSync(yamlPath)) return { changed: false, action: 'skipped', reason: 'no tag_taxonomy.yaml' };
  if (!existsSync(mdPath)) return { changed: false, action: 'skipped', reason: 'no Tag_taxonomy.md' };

  const md = readFileSync(mdPath, 'utf-8');
  const bi = md.indexOf(BEGIN);
  const ei = md.indexOf(END, bi);
  if (bi === -1 || ei === -1) {
    return { changed: false, action: 'skipped', reason: 'generated-tag-taxonomy markers missing' };
  }

  const body = renderBody(readCanon(yamlPath));
  const rebuilt = md.slice(0, bi) + `${BEGIN}\n\n${body}\n\n${END}` + md.slice(ei + END.length);
  if (rebuilt === md) return { changed: false, action: 'noop' };
  writeFileSync(mdPath, rebuilt);
  return { changed: true, action: 'updated' };
}
