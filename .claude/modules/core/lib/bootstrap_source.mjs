// Bootstrap source marker — trace + drift check for materialized vaults.
//
// Phase 6.1+ (D19): vaults carry a `.claude/.bootstrap-source.json` marker
// written by setup.mjs at materialize time. It records the bootstrap repo
// path, its HEAD commit, and the version of each module that was copied.
// `/init-vault` compares the marker against current bootstrap versions and
// stops the run with an actionable error if the vault is stale.
//
// This module exposes both helpers (used by setup.mjs at write time) and a
// CLI entry point (`node bootstrap_source.mjs --vault-root <path>`) for
// /init-vault to invoke at read time. JSON on stdout, exit 0 for any
// recognised state (action ∈ ok|drift|no_marker|repo_inaccessible|
// repo_missing_modules), non-zero only for unexpected I/O errors.

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const MARKER_REL_PATH = '.claude/.bootstrap-source.json';
const MARKER_SCHEMA_VERSION = 1;

function normalizePath(p) {
  return resolve(p).replace(/\\/g, '/');
}

/**
 * Read `name` and `version` fields from a module.yaml file via a minimal
 * regex parse. Avoids a YAML dependency — the format is a flat top-level
 * map for these two keys across every module in the framework.
 */
function readModuleNameVersion(yamlPath) {
  const text = readFileSync(yamlPath, 'utf-8');
  const name = (text.match(/^name:\s*(\S+)/m) || [])[1] || null;
  const version = (text.match(/^version:\s*(\S+)/m) || [])[1] || null;
  return { name, version };
}

/**
 * Read all module versions from a `modules/` directory (bootstrap repo OR
 * vault `.claude/modules/`). Returns {moduleName: version} for every
 * subdirectory that contains a module.yaml.
 */
export function readModuleVersions(modulesDir) {
  const out = {};
  if (!existsSync(modulesDir)) return out;
  for (const entry of readdirSync(modulesDir)) {
    const yamlPath = join(modulesDir, entry, 'module.yaml');
    if (!existsSync(yamlPath)) continue;
    const { name, version } = readModuleNameVersion(yamlPath);
    if (name && version) out[name] = version;
  }
  return out;
}

/**
 * Read the HEAD commit of a bootstrap repo. Best-effort: returns null if
 * git is unavailable or the path is not a repo. Short SHA (7 chars).
 */
export function readBootstrapCommit(bootstrapRepo) {
  try {
    const out = execSync('git rev-parse --short HEAD', {
      cwd: bootstrapRepo,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Write the marker file. Idempotent — overwrites any existing marker so
 * setup.mjs reflects the latest materialized state.
 */
export function writeMarker(vaultRoot, { bootstrapRepo, commit, modules }) {
  const markerPath = join(vaultRoot, MARKER_REL_PATH);
  const payload = {
    schema_version: MARKER_SCHEMA_VERSION,
    bootstrap_repo: normalizePath(bootstrapRepo),
    bootstrap_repo_commit: commit,
    materialized_at: new Date().toISOString(),
    modules,
  };
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, JSON.stringify(payload, null, 2) + '\n');
  return markerPath;
}

/**
 * Read the marker from a vault. Returns null if absent. Throws on
 * malformed JSON — callers treat that as a hard error.
 */
export function readMarker(vaultRoot) {
  const markerPath = join(vaultRoot, MARKER_REL_PATH);
  if (!existsSync(markerPath)) return null;
  const text = readFileSync(markerPath, 'utf-8');
  return JSON.parse(text);
}

/**
 * Compare marker against current bootstrap state. Pure function over inputs.
 *
 * Actions:
 *   - no_marker            — vault was materialized before D19 (or marker
 *                            was deleted). Non-blocking; init-vault warns
 *                            and continues.
 *   - repo_inaccessible    — marker exists but bootstrap_repo path does
 *                            not exist or is not a directory. Non-blocking.
 *   - ok                   — every module's marker version matches current
 *                            bootstrap version.
 *   - drift                — at least one module diverges. Blocking —
 *                            init-vault must stop and ask user to re-run
 *                            setup.mjs.
 */
export function checkDrift({ vaultRoot }) {
  let marker;
  try {
    marker = readMarker(vaultRoot);
  } catch (err) {
    return {
      action: 'malformed_marker',
      error: err.message,
    };
  }

  if (!marker) {
    return { action: 'no_marker' };
  }

  const bootstrapRepo = marker.bootstrap_repo;
  if (!bootstrapRepo || !existsSync(bootstrapRepo)) {
    return {
      action: 'repo_inaccessible',
      marker,
      bootstrap_repo: bootstrapRepo,
    };
  }

  const bootstrapModulesDir = join(bootstrapRepo, 'modules');
  if (!existsSync(bootstrapModulesDir)) {
    return {
      action: 'repo_inaccessible',
      marker,
      bootstrap_repo: bootstrapRepo,
      reason: 'modules/ directory missing in bootstrap repo',
    };
  }

  const currentVersions = readModuleVersions(bootstrapModulesDir);
  const currentCommit = readBootstrapCommit(bootstrapRepo);
  const drift = [];

  // Compare every module recorded in marker against current bootstrap.
  for (const [name, localVersion] of Object.entries(marker.modules || {})) {
    const bootstrapVersion = currentVersions[name];
    if (!bootstrapVersion) {
      drift.push({ module: name, local: localVersion, bootstrap: null, kind: 'removed_from_bootstrap' });
      continue;
    }
    if (bootstrapVersion !== localVersion) {
      drift.push({ module: name, local: localVersion, bootstrap: bootstrapVersion, kind: 'version_changed' });
    }
  }

  // Modules present in bootstrap but not in marker (new modules added to
  // framework since last materialize) — also drift, user should re-copy.
  for (const [name, bootstrapVersion] of Object.entries(currentVersions)) {
    if (!(name in (marker.modules || {}))) {
      drift.push({ module: name, local: null, bootstrap: bootstrapVersion, kind: 'added_to_bootstrap' });
    }
  }

  return {
    action: drift.length === 0 ? 'ok' : 'drift',
    marker,
    bootstrap_repo: bootstrapRepo,
    marker_commit: marker.bootstrap_repo_commit || null,
    current_commit: currentCommit,
    drift,
  };
}

// ---------------------------------------------------------------------------
// CLI: invoked by /init-vault skill at the start of every run.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { vaultRoot: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault-root') {
      args.vaultRoot = argv[++i];
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`bootstrap_source.mjs — D19 drift check

Usage:
  node bootstrap_source.mjs --vault-root <abs-path>

Reads <vault>/.claude/.bootstrap-source.json, compares module versions
against the bootstrap repo recorded in the marker, prints JSON on stdout.

Exit codes:
  0 — any recognised action (ok|drift|no_marker|repo_inaccessible|malformed_marker)
  1 — unexpected I/O error`);
}

function isMain() {
  // Robust ESM main-module check across launchers (resolves symlinks +
  // forward/back-slash differences on Windows).
  if (!process.argv[1]) return false;
  const entry = resolve(process.argv[1]).replace(/\\/g, '/');
  const self = resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:'))
    .replace(/\\/g, '/');
  return entry === self;
}

if (isMain()) {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(JSON.stringify({ status: 'error', message: err.message }));
    process.exit(1);
  }
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.vaultRoot) {
    console.error(JSON.stringify({ status: 'error', message: '--vault-root is required' }));
    process.exit(1);
  }
  try {
    const result = checkDrift({ vaultRoot: resolve(args.vaultRoot) });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ status: 'error', message: err.message, stack: err.stack }));
    process.exit(1);
  }
}
