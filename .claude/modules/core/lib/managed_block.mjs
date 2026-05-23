// Idempotent managed-block helper for /init-vault modules.
//
// Manages a marked region inside a target file:
//   <BEGIN-MARKER>
//   ... module-controlled content ...
//   <END-MARKER>
//
// First run appends the block. Subsequent runs replace its body.
// Content outside the markers is never touched.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const STYLES = {
  html: { begin: '<!-- BEGIN: managed by /init-vault -->', end: '<!-- END: managed by /init-vault -->' },
  hash: { begin: '# BEGIN: managed by /init-vault', end: '# END: managed by /init-vault' },
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Ensure a managed-block in `filePath` contains exactly `content`.
 *
 * @param {string} filePath - Absolute path to the target file.
 * @param {string} content - Body of the block (without markers, no trailing newline).
 * @param {'html'|'hash'} style - Comment style for the markers.
 * @returns {{ changed: boolean, action: 'created'|'appended'|'replaced'|'noop' }}
 */
export function ensureManagedBlock(filePath, content, style = 'html') {
  const { begin, end } = STYLES[style];
  const trimmed = content.trim();
  const newBlock = `${begin}\n${trimmed}\n${end}`;

  let body = '';
  let fileExisted = false;
  if (existsSync(filePath)) {
    body = readFileSync(filePath, 'utf-8');
    fileExisted = true;
  }

  const blockRe = new RegExp(`${escapeRegex(begin)}[\\s\\S]*?${escapeRegex(end)}`);
  if (blockRe.test(body)) {
    const replaced = body.replace(blockRe, newBlock);
    if (replaced === body) return { changed: false, action: 'noop' };
    writeFileSync(filePath, replaced);
    return { changed: true, action: 'replaced' };
  }

  let updated;
  if (!fileExisted || body.length === 0) {
    updated = newBlock + '\n';
  } else {
    const sep = body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n';
    updated = body + sep + newBlock + '\n';
  }
  writeFileSync(filePath, updated);
  return { changed: true, action: fileExisted ? 'appended' : 'created' };
}

/**
 * Check whether the outer managed-block (created by `core`) exists in `filePath`.
 *
 * @param {string} filePath - Absolute path to the target file.
 * @param {'html'|'hash'} style - Comment style.
 * @returns {boolean}
 */
export function hasOuterBlock(filePath, style = 'html') {
  if (!existsSync(filePath)) return false;
  const body = readFileSync(filePath, 'utf-8');
  const { begin, end } = STYLES[style];
  return body.includes(begin) && body.includes(end);
}

/**
 * Ensure a module sub-block lives INSIDE the outer managed-block of `filePath`.
 *
 * Markers: `<!-- BEGIN: module:<moduleName> -->` ... `<!-- END: module:<moduleName> -->`.
 * Idempotent: if the sub-block already exists anywhere, its body is replaced in place.
 * Otherwise inserts it just before the outer END marker.
 *
 * Requires the outer block to already exist (i.e. `core` has been installed).
 * Always uses HTML comment style — sub-blocks are intended for CLAUDE.md.
 *
 * @param {string} filePath - Absolute path.
 * @param {string} moduleName - Module identifier (kebab-case).
 * @param {string} content - Body of the sub-block (no markers, no trailing newline).
 * @returns {{ changed: boolean, action: 'inserted'|'replaced'|'noop' }}
 */
export function ensureSubBlock(filePath, moduleName, content) {
  if (!existsSync(filePath)) {
    throw new Error(`Sub-block target ${filePath} does not exist — install \`core\` first.`);
  }
  const outer = STYLES.html;
  if (!hasOuterBlock(filePath, 'html')) {
    throw new Error(`Outer managed-block missing in ${filePath} — install \`core\` first.`);
  }

  const begin = `<!-- BEGIN: module:${moduleName} -->`;
  const end = `<!-- END: module:${moduleName} -->`;
  const trimmed = content.trim();
  const newBlock = `${begin}\n${trimmed}\n${end}`;

  const body = readFileSync(filePath, 'utf-8');
  const subRe = new RegExp(`${escapeRegex(begin)}[\\s\\S]*?${escapeRegex(end)}`);
  if (subRe.test(body)) {
    const replaced = body.replace(subRe, newBlock);
    if (replaced === body) return { changed: false, action: 'noop' };
    writeFileSync(filePath, replaced);
    return { changed: true, action: 'replaced' };
  }

  // Insert just before the outer END marker.
  const idx = body.indexOf(outer.end);
  const before = body.slice(0, idx);
  const after = body.slice(idx);
  const sepBefore = before.endsWith('\n') ? '' : '\n';
  const updated = before + sepBefore + newBlock + '\n' + after;
  writeFileSync(filePath, updated);
  return { changed: true, action: 'inserted' };
}

/**
 * Remove a module sub-block from `filePath` (for module remove handlers).
 *
 * @param {string} filePath
 * @param {string} moduleName
 * @returns {{ changed: boolean, action: 'removed'|'noop' }}
 */
export function removeSubBlock(filePath, moduleName) {
  if (!existsSync(filePath)) return { changed: false, action: 'noop' };
  const begin = `<!-- BEGIN: module:${moduleName} -->`;
  const end = `<!-- END: module:${moduleName} -->`;
  const body = readFileSync(filePath, 'utf-8');
  const subRe = new RegExp(`\\n?${escapeRegex(begin)}[\\s\\S]*?${escapeRegex(end)}\\n?`);
  if (!subRe.test(body)) return { changed: false, action: 'noop' };
  writeFileSync(filePath, body.replace(subRe, '\n'));
  return { changed: true, action: 'removed' };
}
