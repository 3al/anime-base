// Shared install root manager — pre-install orchestration for modules
// declaring `install_scope: shared` in their module.yaml.
//
// Contract (Shared_Install_Architecture.md §7 + §11):
//   The /init-vault skill calls this BEFORE invoking the module's install
//   handler. This module:
//     * Computes current source_sha from <bootstrap>/modules/<name>/.
//     * Reads $shared_module_dir/.installed marker (if present).
//     * Decides action: first_install | version_bump | refresh_source | noop.
//     * Mutates the shared root accordingly (mkdir, rm-rf, cp -r).
//     * Returns the decision + paths for the install handler.
//
// CLI usage (called by /init-vault skill via Bash):
//   node core/lib/shared_install.mjs \
//     --bootstrap-module-dir <abs> \
//     --shared-module-dir   <abs> \
//     --version             <semver>
//
// Outputs JSON on stdout:
//   { action, source_sha, source_copied, shared_module_dir }
// Exits non-zero on error with JSON error on stderr.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync, readdirSync, statSync, cpSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { homedir, platform as osPlatform } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolveSharedToolsHome } from './paths.mjs';
import { logVenvOp, venvAuditPath } from './venv_audit.mjs';

// Deny-list for source_sha — directories whose names trigger skip at any depth.
const SKIP_DIRS = new Set(['.venv', 'data', 'dist', 'node_modules', '__pycache__']);

// Deny-list for source_sha — file names skipped at any depth.
const SKIP_FILES = new Set(['.installed', '.install.lock']);

// Extension-based skip (case-insensitive).
const SKIP_EXTS = new Set(['.pyc']);

/**
 * Returns true if a path entry (by basename) should be included in source
 * operations — both content hashing (computeSourceSha) and source-copy
 * (cpSync filter). Single source of truth so the two stay in sync: if
 * walkSource skips X, the copy must skip X too, otherwise X pollutes the
 * shared root and gets hashed-around (e.g. legacy mcp/data/hf-cache being
 * duplicated under shared/mcp/data when it already lives in shared/data).
 *
 * Note: callers pass either a full path or just a name — basename() is
 * a no-op for the latter.
 */
function shouldIncludeEntry(pathOrName, isDir) {
  const name = basename(pathOrName);
  if (isDir) return !SKIP_DIRS.has(name);
  if (SKIP_FILES.has(name)) return false;
  const ext = name.includes('.') ? '.' + name.split('.').pop().toLowerCase() : '';
  return !SKIP_EXTS.has(ext);
}

/**
 * cpSync filter callback. Returns true to copy, false to skip.
 * Skips deny-listed dirs/files at any depth — symmetric with walkSource.
 */
function copyFilter(src) {
  let isDir = false;
  try { isDir = statSync(src).isDirectory(); } catch { /* doesn't exist; let cp handle */ }
  return shouldIncludeEntry(src, isDir);
}

/**
 * Walk a directory recursively, yielding files in deterministic sorted order
 * relative to `rootDir`. Skips paths matching the deny-list.
 */
function* walkSource(rootDir) {
  const entries = readdirSync(rootDir, { withFileTypes: true })
    .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = join(rootDir, e.name);
    if (!shouldIncludeEntry(e.name, e.isDir)) continue;
    if (e.isDir) {
      yield* walkSource(full);
    } else {
      yield full;
    }
  }
}

/**
 * Compute deterministic SHA256 hash representing the module's source state.
 *
 * Per Shared_Install_Architecture.md §7.2: hash of (relative_path|sha256) lines
 * for every file under the module dir, deny-list applied, alphabetical order.
 * Hashing the relative path along with content prevents file renames from
 * silently producing the same digest.
 *
 * @param {string} moduleDir - abs path to <bootstrap>/modules/<name>/
 * @returns {string} hex sha256 (64 chars)
 */
export function computeSourceSha(moduleDir) {
  const hash = createHash('sha256');
  for (const file of walkSource(moduleDir)) {
    const rel = relative(moduleDir, file).replace(/\\/g, '/');
    const buf = readFileSync(file);
    const fileSha = createHash('sha256').update(buf).digest('hex');
    hash.update(`${rel}|${fileSha}\n`);
  }
  return hash.digest('hex');
}

/**
 * Read the shared-root marker. Returns null if missing or unparseable.
 * @returns {{version: string, source_sha: string, installed_at: string} | null}
 */
export function readSharedMarker(sharedModuleDir) {
  const p = join(sharedModuleDir, '.installed');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Decide what action provisioning needs to take based on current source vs marker.
 *
 * @param {{version: string, source_sha: string}} current - what we have on disk in bootstrap
 * @param {object|null} marker - existing shared-root marker, or null if first install
 * @returns {'first_install'|'version_bump'|'refresh_source'|'noop'}
 */
export function decideAction(current, marker) {
  if (!marker) return 'first_install';
  if (marker.version !== current.version) return 'version_bump';
  if (marker.source_sha !== current.source_sha) return 'refresh_source';
  return 'noop';
}

/**
 * Phase 6.1 D18 fix: scan the OS process list for live processes whose
 * command line references the given shared root path. Returns array of
 * {pid, cmdline} live processes — empty array means nothing holds files
 * in this shared root, even if static registrations exist.
 *
 * Windows: PowerShell Get-CimInstance Win32_Process.
 * Linux/Mac: ps -eo pid,command.
 * On probe failure (no powershell, no ps, permission denied) — returns
 * {probed: false}, callers should fall back to treating any registered
 * consumer as alive (fail-safe overscan).
 */
function probeLiveProcesses(sharedRoot) {
  const norm = sharedRoot.replace(/\\/g, '/').toLowerCase();
  const plat = osPlatform();

  // Exclude our own probe process from results: it spawns a child whose
  // command line itself contains the shared root path, causing a self-match.
  // We can't know the child PID up-front, so exclude any process whose
  // cmdline looks like our probe shape (Get-CimInstance Win32_Process / ps).
  const isSelfProbe = (cmdline) => {
    if (typeof cmdline !== 'string') return false;
    return (
      cmdline.includes('Get-CimInstance Win32_Process') ||
      /\bps\s+-eo\s+pid,command\b/.test(cmdline)
    );
  };
  const ownPid = process.pid;

  if (plat === 'win32') {
    // PowerShell needs the path with single quotes; double-quote the path
    // inside via "" to safely embed any spaces. Filter command lines that
    // reference our shared root (forward or backslashes).
    const psScript =
      `Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.CommandLine -and ($_.CommandLine -like '*${sharedRoot.replace(/'/g, "''")}*' -or $_.CommandLine -like '*${norm.replace(/'/g, "''")}*') } | ` +
      `Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`;
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0 && r.status !== null) {
      return { probed: false, alive: [], error: (r.stderr || '').slice(0, 200) };
    }
    const stdout = (r.stdout || '').trim();
    if (!stdout) return { probed: true, alive: [] };
    try {
      let parsed = JSON.parse(stdout);
      if (parsed === null) return { probed: true, alive: [] };
      if (!Array.isArray(parsed)) parsed = [parsed];
      const filtered = parsed
        .map((p) => ({ pid: p.ProcessId, cmdline: p.CommandLine }))
        .filter((p) => p.pid !== ownPid && !isSelfProbe(p.cmdline));
      return { probed: true, alive: filtered };
    } catch (e) {
      return { probed: false, alive: [], error: `JSON parse: ${e.message}` };
    }
  }

  // Linux / macOS — ps with full command line
  const r = spawnSync('ps', ['-eo', 'pid,command'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    return { probed: false, alive: [], error: (r.stderr || '').slice(0, 200) };
  }
  const alive = [];
  for (const line of (r.stdout || '').split('\n')) {
    const lower = line.toLowerCase();
    if (!lower.includes(norm) && !line.includes(sharedRoot)) continue;
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const entry = { pid: Number(m[1]), cmdline: m[2] };
    if (entry.pid === ownPid) continue;
    if (isSelfProbe(entry.cmdline)) continue;
    alive.push(entry);
  }
  return { probed: true, alive };
}

/**
 * Normalize a filesystem path for comparison. Backslash → forward slash,
 * strip trailing slashes, and lower-case on case-insensitive filesystems
 * (Windows, macOS HFS+/APFS-default). On Linux case is preserved.
 */
function normalizePathForCompare(p) {
  const plat = osPlatform();
  const caseInsensitive = plat === 'win32' || plat === 'darwin';
  const n = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return caseInsensitive ? n.toLowerCase() : n;
}

/**
 * Phase 6.1 D7+D18 + D20 fix: find consumers of a shared_module_dir.
 *
 * Two-step:
 *   1. Static scan of ~/.claude.json (and opts.extra_configs) for
 *      mcpServers entries whose command/args/env reference paths in
 *      shared_module_dir. These are "registered" consumers.
 *   2. Process probe via probeLiveProcesses(). For each registered entry,
 *      check if a live OS process references the shared root.
 *
 * D20 (self-exclude): opts.self_vault_root, when set, marks any registered
 * entry whose project key matches that vault path as `is_self: true`. The
 * caller's own CC session is then non-blocking — without this, in-session
 * shared upgrades from the consumer's own vault are perpetually blocked by
 * the very MCP processes that session spawned (catch-22).
 *
 * Heuristic for live-process attribution: we cannot map a PID → registered
 * entry from cmdline alone (Phase 4.7 shim's argv references shared paths,
 * not the per-vault data dir; env vars don't surface in Win32 CommandLine).
 * So: if every registered entry is self, attribute all live processes to
 * self_session (non-blocking). If any non-self entry is registered, live
 * processes might belong to it → conservatively block.
 *
 * Returns:
 *   {
 *     active: [{...entry, probe: 'alive', live_pids}],     // non-self live → blocking
 *     self_session: [{...entry, probe: 'alive', live_pids}], // self entries (informational, non-blocking)
 *     stale: [{...entry, probe: 'stale'}],                  // registered but no process
 *     probed: bool,         // false → probe failed; non-self registered get probe='probe_failed'
 *     probe_error: string?,
 *     live_processes: [{pid, cmdline}]?,
 *   }
 *
 * Empty active[] means safe to proceed with destructive ops.
 *
 * Scans by default ~/.claude.json (Claude Code). Pass opts.extra_configs
 * to include opencode or other agents.
 */
export function findActiveConsumers(shared_module_dir, opts = {}) {
  const normShared = shared_module_dir.replace(/\\/g, '/').replace(/\/+$/, '');
  const normSelf = opts.self_vault_root ? normalizePathForCompare(opts.self_vault_root) : null;
  const configs = [
    join(homedir(), '.claude.json'),
    ...(opts.extra_configs || []),
  ];
  const registered = [];

  for (const configFile of configs) {
    if (!existsSync(configFile)) continue;
    let data;
    try {
      data = JSON.parse(readFileSync(configFile, 'utf-8'));
    } catch {
      continue; // unparseable — skip silently, not our problem
    }
    const projects = data.projects || {};
    for (const [projKey, proj] of Object.entries(projects)) {
      const servers = (proj && proj.mcpServers) || {};
      for (const [serverName, srv] of Object.entries(servers)) {
        const refs = [];
        if (typeof srv.command === 'string') refs.push(srv.command);
        if (Array.isArray(srv.args)) refs.push(...srv.args.filter((a) => typeof a === 'string'));
        if (srv.env && typeof srv.env === 'object') {
          for (const v of Object.values(srv.env)) {
            if (typeof v === 'string') refs.push(v);
          }
        }
        for (const ref of refs) {
          const normRef = ref.replace(/\\/g, '/');
          if (normRef.startsWith(normShared)) {
            const is_self = normSelf !== null && normalizePathForCompare(projKey) === normSelf;
            registered.push({
              config_file: configFile,
              project: projKey,
              server_name: serverName,
              ref_path: ref,
              is_self,
            });
            break;
          }
        }
      }
    }
  }

  const selfEntries = registered.filter((c) => c.is_self);
  const otherEntries = registered.filter((c) => !c.is_self);

  // D18: process probe to distinguish active vs stale registrations.
  // opts._probe is a test-only hook returning the same shape as
  // probeLiveProcesses (no live OS scan needed in unit tests).
  const probe = opts._probe ? opts._probe(shared_module_dir) : probeLiveProcesses(shared_module_dir);

  if (!probe.probed) {
    // Probe failed — fail-safe: treat non-self as active. Self entries are
    // still classified as self_session (their own CC session's probe failure
    // is no reason to block that same session's upgrade).
    return {
      active: otherEntries.map((c) => ({ ...c, probe: 'probe_failed' })),
      self_session: selfEntries.map((c) => ({ ...c, probe: 'probe_failed' })),
      stale: [],
      probed: false,
      probe_error: probe.error,
    };
  }

  if (probe.alive.length === 0) {
    // No live processes — everything registered is stale, including self
    // (the user closed every consumer of this shared root).
    return {
      active: [],
      self_session: [],
      stale: registered.map((c) => ({ ...c, probe: 'stale' })),
      probed: true,
    };
  }

  // Some live processes found. Heuristic: live PIDs can't be precisely
  // mapped to registered entries (see jsdoc), so conservatively attribute
  // them to ALL non-self entries (any of them might own a PID → blocking).
  // Self entries are non-blocking regardless of live state — they belong
  // to the caller's own session, which is the one driving the upgrade.
  const livePids = probe.alive.map((p) => p.pid);
  return {
    active: otherEntries.map((c) => ({ ...c, probe: 'alive', live_pids: livePids })),
    self_session: selfEntries.map((c) => ({ ...c, probe: 'alive', live_pids: livePids })),
    stale: [],
    probed: true,
    live_processes: probe.alive,
  };
}

/**
 * Phase 6.1 fix (D11): two-phase destructive op for shared root.
 * Phase 1: rename existing tree to *.bak-<ts> (atomic on the same fs).
 * Phase 2: caller-supplied work (e.g. cpSync new source).
 * Phase 3 (on success): rmSync the .bak.
 * On Phase 2 failure: restore .bak by renaming back.
 *
 * `targets` is a list of abs paths to rename-aside. Each must exist or be
 * absent (we ignore non-existent). All renames happen before work runs.
 *
 * NB: on Windows, rename of a dir whose files have OPEN HANDLES will EPERM
 * just like rmSync would. The D7 active-consumer pre-check is the real
 * guard; this pattern guards against transient IO failures during the
 * destructive sequence itself (disk full mid-copy, etc).
 */
function atomicSwap(targets, work, auditFile = null) {
  const ts = Date.now();
  const renamed = []; // [{from, to}]
  try {
    for (const t of targets) {
      if (!existsSync(t)) continue;
      const bak = `${t}.bak-${ts}`;
      if (auditFile) logVenvOp(auditFile, 'atomic_swap_rename', { from: t, to: bak });
      renameSync(t, bak);
      renamed.push({ from: t, to: bak });
    }
  } catch (err) {
    if (auditFile) logVenvOp(auditFile, 'atomic_swap_rename_failed', { error: err.message, renamed_so_far: renamed.map((r) => r.to) });
    // Rollback any rename that succeeded.
    for (const r of renamed.reverse()) {
      try { renameSync(r.to, r.from); } catch { /* best-effort */ }
    }
    throw new Error(`atomicSwap rename phase failed: ${err.message}`);
  }

  let workErr = null;
  try {
    work();
  } catch (err) {
    workErr = err;
  }

  if (workErr) {
    if (auditFile) logVenvOp(auditFile, 'atomic_swap_work_failed', { error: workErr.message, rollback_targets: renamed.map((r) => r.from) });
    // Work failed — restore .bak. If anything was already created at the
    // original path during work(), wipe it first.
    for (const r of renamed.reverse()) {
      try {
        if (existsSync(r.from)) {
          if (auditFile) logVenvOp(auditFile, 'atomic_swap_rollback_rm', { target: r.from });
          rmSync(r.from, { recursive: true, force: true });
        }
      } catch { /* swallow */ }
      try {
        if (auditFile) logVenvOp(auditFile, 'atomic_swap_rollback_restore', { from: r.to, to: r.from });
        renameSync(r.to, r.from);
      } catch { /* best-effort */ }
    }
    throw workErr;
  }

  // Work succeeded — drop .bak (best-effort; if EPERM, leave for next run).
  for (const r of renamed) {
    try {
      if (auditFile) logVenvOp(auditFile, 'atomic_swap_cleanup', { target: r.to });
      rmSync(r.to, { recursive: true, force: true });
    } catch (e) {
      if (auditFile) logVenvOp(auditFile, 'atomic_swap_cleanup_failed', { target: r.to, error: e.message });
    }
  }
}

/**
 * Provision the shared install root for a module: ensure the source-tree mirror
 * at $shared_module_dir/mcp/ matches the bootstrap source, with the right side
 * effects on $shared_module_dir/.venv/ based on action.
 *
 * NOTE: This does NOT create or touch the venv. Venv lifecycle is the install
 * handler's responsibility. On version_bump we delete the existing venv so the
 * handler recreates it; on refresh_source we leave the venv intact.
 *
 * Preserves $shared_module_dir/data/ (HF model cache) across all actions —
 * losing it would force a ~2 GB re-download.
 *
 * Phase 6.1 fix (D7): before destructive actions (version_bump, refresh_source)
 * checks ~/.claude.json for active consumers of this shared root. If any are
 * found, returns action='aborted_active_consumers' without touching anything,
 * so the caller can prompt the user to close those sessions.
 *
 * @param {object} opts
 * @param {string} opts.bootstrap_module_dir - abs path to <bootstrap>/modules/<name>/
 * @param {string} opts.shared_module_dir - abs path to $VAULT_TOOLS_HOME/<name>/
 * @param {string} opts.version - current module.yaml version
 * @param {string} opts.source_sha - precomputed via computeSourceSha()
 * @param {string} [opts.self_vault_root] - abs path to the vault driving this
 *   install. Used by findActiveConsumers to mark same-vault consumers as
 *   self_session (non-blocking). D20 fix: without this, in-session shared
 *   upgrades from the consumer's own vault are perpetually blocked by their
 *   own live MCP processes (catch-22).
 * @returns {{action: string, source_copied: boolean, venv_dropped: boolean, active_consumers?: object[]}}
 */
export function provisionSharedRoot({ bootstrap_module_dir, shared_module_dir, version, source_sha, self_vault_root, _probe, extra_configs }) {
  if (!existsSync(bootstrap_module_dir)) {
    throw new Error(`bootstrap_module_dir does not exist: ${bootstrap_module_dir}`);
  }
  const srcMcp = join(bootstrap_module_dir, 'mcp');
  if (!existsSync(srcMcp)) {
    throw new Error(`bootstrap module is missing mcp/ subdir: ${srcMcp}`);
  }

  const marker = readSharedMarker(shared_module_dir);
  const action = decideAction({ version, source_sha }, marker);

  const dstMcp = join(shared_module_dir, 'mcp');
  const venvDir = join(shared_module_dir, '.venv');
  const auditFile = venvAuditPath(shared_module_dir);

  // D22: log provision entry point — when this fires, we know shared_install.mjs
  // is the caller. Differentiates from install.mjs's own ensureVenvAndInstall.
  logVenvOp(auditFile, 'provision_shared_root_start', {
    action,
    bootstrap_module_dir,
    shared_module_dir,
    version,
    source_sha: source_sha.slice(0, 12),
    self_vault_root: self_vault_root || null,
  });

  let source_copied = false;
  let venv_dropped = false;

  // Phase 6.1 (D7+D18+D20) → D21 (v0.7.2): destructive actions used to abort
  // when ANY non-self live consumer was registered. That was overly conservative
  // — D11 atomicSwap (rename-aside before destructive write) guarantees safety
  // regardless of which CC session owns the live FDs. Process FDs pin the
  // renamed-aside inode (the OLD tree at *.bak-<ts>); the fresh path gets new
  // bytes. Cross-vault sessions continue running against the OLD code in
  // memory until they restart, then pick up the new tree. No corruption, no
  // breakage.
  //
  // D21 drops the cross-vault pre-flight block. We still GATHER consumer info
  // for the result payload so callers can warn the user: "cross-vault CC
  // sessions for projects X, Y will continue on old code until they restart".
  //
  // Edge case (still handled): if rename itself fails because Windows file
  // locks (rare — Python .pyd via LoadLibrary doesn't usually exclude
  // share-delete, but theoretically possible) → atomicSwap throws, we catch
  // and emit `action: 'aborted_atomic_swap_locked'` with consumer info. This
  // is the new "real block" status; pre-emptive registration-based blocking
  // is gone.
  const destructive = action === 'refresh_source' || action === 'version_bump';
  let consumers_snapshot = null;
  if (destructive) {
    consumers_snapshot = findActiveConsumers(shared_module_dir, {
      self_vault_root,
      _probe,
      extra_configs,
    });
  }

  try {
    switch (action) {
      case 'noop':
        // Source + venv up-to-date; install handler will verify and write per-vault state.
        break;

      case 'refresh_source':
      case 'version_bump': {
        // D23 (v0.7.4): unified treatment. Previously version_bump also
        // atomicSwap'd venv (dropped + forced recreate). That caused
        // unnecessary 2.6+ GB torch redownload on every minor version bump,
        // wasted ~7 min per upgrade, and risked MCP harness racing to
        // recreate empty .venv during the swap window (see D22 audit log).
        //
        // After D23: both actions only swap source (`mcp/`). The existing
        // venv stays. pip install -e in the install handler updates the
        // editable link and incrementally upgrades any changed deps —
        // torch/sentence-transformers/etc. that match pyproject pins stay
        // put. If venv is genuinely broken (incompatible Python upgrade,
        // corrupted state), `ensureVenvAndInstall::venvHealthy` catches it
        // and triggers explicit recreate at that layer (better signal,
        // logged via D22 venv-audit). atomicSwap still protects the source
        // dir from transient IO failures during cpSync.
        mkdirSync(shared_module_dir, { recursive: true });
        atomicSwap([dstMcp], () => {
          cpSync(srcMcp, dstMcp, { recursive: true, filter: copyFilter });
        }, auditFile);
        source_copied = true;
        // venv_dropped stays false — D23 never drops venv at provision layer.
        break;
      }

      case 'first_install':
        mkdirSync(shared_module_dir, { recursive: true });
        cpSync(srcMcp, dstMcp, { recursive: true, filter: copyFilter });
        source_copied = true;
        break;

      default:
        throw new Error(`Unhandled action: ${action}`);
    }
  } catch (err) {
    // D21: atomicSwap rename failed (Windows file lock — rare; can happen
    // when a process opened a file in the tree without FILE_SHARE_DELETE).
    // Surface as structured abort with consumer info so caller can prompt
    // user to close the offending CC sessions.
    if (destructive && /atomicSwap rename phase failed/i.test(err.message)) {
      return {
        action: 'aborted_atomic_swap_locked',
        source_copied: false,
        venv_dropped: false,
        error: err.message,
        active_consumers: consumers_snapshot ? consumers_snapshot.active : [],
        self_session_consumers: consumers_snapshot ? consumers_snapshot.self_session : [],
        stale_consumers: consumers_snapshot ? consumers_snapshot.stale : [],
        probed: consumers_snapshot ? consumers_snapshot.probed : null,
        live_processes: consumers_snapshot ? consumers_snapshot.live_processes : [],
        planned_action: action,
      };
    }
    throw err;
  }

  // D22: log provision exit state — captures venv path existence after our work.
  logVenvOp(auditFile, 'provision_shared_root_done', {
    action,
    source_copied,
    venv_dropped,
    venv_exists_after: existsSync(venvDir),
    mcp_exists_after: existsSync(dstMcp),
  });

  // D21: include consumer snapshot in successful destructive results so caller
  // can warn user about cross-vault sessions running on OLD code post-swap.
  const result = { action, source_copied, venv_dropped };
  if (consumers_snapshot && destructive) {
    if (consumers_snapshot.active.length > 0) {
      result.cross_vault_consumers = consumers_snapshot.active;
    }
    if (consumers_snapshot.self_session.length > 0) {
      result.self_session_consumers = consumers_snapshot.self_session;
    }
    if (consumers_snapshot.stale.length > 0) {
      result.stale_consumers = consumers_snapshot.stale;
    }
    if (consumers_snapshot.probed === false) {
      result.probe_failed = true;
      result.probe_error = consumers_snapshot.probe_error;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-/g, '_');
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = val;
      i++;
    }
  }
  return args;
}

function readModuleVersion(moduleDir) {
  const p = join(moduleDir, 'module.yaml');
  if (!existsSync(p)) throw new Error(`module.yaml not found in ${moduleDir}`);
  const m = readFileSync(p, 'utf-8').match(/^version:\s*(.+)$/m);
  if (!m) throw new Error(`version field not found in ${p}`);
  return m[1].trim();
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.bootstrap_module_dir) {
    process.stderr.write(JSON.stringify({ error: 'Missing required argument --bootstrap-module-dir' }));
    process.exit(2);
  }

  // Resolve shared_module_dir: either passed explicitly, or computed from
  // --module-name + $VAULT_TOOLS_HOME (preferred path for /init-vault skill).
  let shared_module_dir = args.shared_module_dir;
  if (!shared_module_dir) {
    if (!args.module_name) {
      process.stderr.write(JSON.stringify({
        error: 'Pass either --shared-module-dir <abs> OR --module-name <name> (will resolve to $VAULT_TOOLS_HOME/<name>).',
      }));
      process.exit(2);
    }
    shared_module_dir = `${resolveSharedToolsHome()}/${args.module_name}`;
  }

  try {
    const version = args.version || readModuleVersion(args.bootstrap_module_dir);
    const source_sha = computeSourceSha(args.bootstrap_module_dir);
    const result = provisionSharedRoot({
      bootstrap_module_dir: args.bootstrap_module_dir,
      shared_module_dir,
      version,
      source_sha,
      self_vault_root: args.self_vault_root,
    });
    console.log(JSON.stringify({
      ...result,
      source_sha,
      version,
      shared_module_dir,
    }, null, 2));
    // Phase 6.1 (D7) → D21: signal non-zero exit only on the real-block status
    // (atomicSwap rename failed — typically Windows file lock from a live
    // process that opened without FILE_SHARE_DELETE). D7's pre-emptive
    // `aborted_active_consumers` no longer fires — atomicSwap is trusted to
    // handle cross-vault live consumers via rename-aside. Stdout JSON still
    // carries the structured detail in either case.
    if (
      result.action === 'aborted_active_consumers' ||
      result.action === 'aborted_atomic_swap_locked'
    ) {
      process.exit(3);
    }
  } catch (err) {
    console.error(JSON.stringify({ error: err.message, stack: err.stack }));
    process.exit(1);
  }
}

// Run only when invoked directly (not when imported).
// process.argv[1] is undefined under `node -e` / `node --eval`; guard for that.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main();
}
