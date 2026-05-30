// Backup-and-patch helper for ~/.claude.json (and similar JSON configs).
//
// Strategy:
//   - Read existing JSON (or {} if absent).
//   - Compute the patched object.
//   - If patched === existing (deep equal) → no-op, no backup written.
//   - Otherwise: write backup with timestamp, then write new content.
//   - Rotate backups: keep newest 5, delete older.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

const BACKUP_KEEP = 5;

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

function rotateBackups(filePath) {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const prefix = `${base}.bak.`;
  let entries;
  try {
    entries = readdirSync(dir).filter((n) => n.startsWith(prefix));
  } catch {
    return;
  }
  const withMtime = entries
    .map((n) => {
      const p = join(dir, n);
      try {
        return { path: p, mtime: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of withMtime.slice(BACKUP_KEEP)) {
    try {
      unlinkSync(old.path);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read JSON from filePath (or return {} if file doesn't exist).
 */
export function readJson(filePath) {
  if (!existsSync(filePath)) return {};
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

/**
 * Write `next` to `filePath`, but only if it differs from current content.
 * On real change: write backup first, rotate backups.
 *
 * @returns {{ changed: boolean, backup_path: string|null }}
 */
export function writeJsonWithBackup(filePath, next) {
  const current = readJson(filePath);
  if (deepEqual(current, next)) {
    return { changed: false, backup_path: null };
  }

  let backupPath = null;
  if (existsSync(filePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${filePath}.bak.${stamp}`;
    writeFileSync(backupPath, readFileSync(filePath));
  }

  writeFileSync(filePath, JSON.stringify(next, null, 2));

  if (backupPath) rotateBackups(filePath);

  return { changed: true, backup_path: backupPath };
}
