#!/usr/bin/env node
// vault-semantic module — install handler.
//
// Branches on install_scope:
//   - shared (default for v0.1.0+, per module.yaml):
//       Heavy artifacts (venv, mcp source copy, hf-cache) live in
//       $shared_module_dir = $VAULT_TOOLS_HOME/vault-semantic/. The
//       /init-vault skill provisions source via core/lib/shared_install.mjs
//       BEFORE invoking this handler — we only manage venv + pip + markers.
//       File-lock at $shared_module_dir/.install.lock guards parallel runs.
//   - per-vault (legacy / fallback):
//       Everything inside <vault>/.claude/modules/vault-semantic/. Used by
//       light modules and for backwards-compatible install.
//
// Contract: Vault_Bootstrap_Architecture.md §«Контракт операций → install»
// + Shared_Install_Architecture.md §7.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, rmSync,
  openSync, closeSync, unlinkSync, cpSync, readdirSync, statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureSubBlock } from '../../core/lib/managed_block.mjs';
import { logVenvOp, venvAuditPath } from '../../core/lib/venv_audit.mjs';
import { readStdin } from '../../core/lib/read_input.mjs';

const SUB_BLOCK_TARGET = 'CLAUDE.md';
const MODULE_NAME = 'vault-semantic';
const SKILL_MARKER = '.managed';
const MIN_PY_MAJOR = 3;
const MIN_PY_MINOR = 11;
const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

// v0.4.0 — torch variant configuration.
// cu126 — единственная стабильная CUDA-линия с cp314 wheels (на момент 2026-05).
// При появлении cp314 wheels для cu128/cu129 — обновить TORCH_CUDA_INDEX или
// сделать probe-driven выбор линии по nvidia-smi driver-version.
const TORCH_CUDA_INDEX = 'https://download.pytorch.org/whl/cu126';
const TORCH_CUDA_VARIANT_TAG = 'cuda_cu126';
const TORCH_CPU_VARIANT_TAG = 'cpu';

// Perf datapoint (RTX 3070 Laptop, 8GB, driver 591.74, cp314+cu126, bge-m3):
//   77 notes / 1354 chunks → 340.8s end-to-end (model load + walk + chunk + embed + sqlite + FTS5).
//   CPU baseline (same hardware, torch+cpu): ~30 min on identical corpus.
// Используется для оценки в SKILL.md prompt; реальный speedup сильно зависит
// от соотношения GPU-bound (embedding) и CPU-bound (chunking + lemmatize + sqlite).
const PERF_HINT = {
  cpu_sec_per_note: 23.4,
  cuda_sec_per_note: 4.5,
  cuda_warmup_sec: 25,
  cpu_disk_gb: 1.2,
  cuda_disk_gb: 3.5,
  measured_on: 'RTX 3070 Laptop / driver 591.74 / Python 3.14 / cp314+cu126',
};


function emit(result) {
  process.stdout.write(JSON.stringify(result, null, 2));
}

function fail(message, extra = {}) {
  emit({
    status: 'error',
    message,
    actions: [],
    warnings: [],
    next_steps: [],
    ...extra,
  });
  process.exit(1);
}

function readModuleVersion(moduleDir) {
  const p = join(moduleDir, 'module.yaml');
  if (!existsSync(p)) return 'unknown';
  const m = readFileSync(p, 'utf-8').match(/^version:\s*(.+)$/m);
  return m ? m[1].trim() : 'unknown';
}

function loadFragment(moduleDir, name) {
  const p = join(moduleDir, 'templates', name);
  if (!existsSync(p)) throw new Error(`Template fragment not found: ${p}`);
  return readFileSync(p, 'utf-8');
}

// Spawn helper. Use shell=true ONLY for launcher probes (py.exe / python aliases
// that need PATHEXT resolution). For abs-path venv binaries pass shell=false to
// avoid cmd.exe quoting issues with `;` and embedded spaces in -c snippets.
function run(cmd, args, { shell = false, ...opts } = {}) {
  const r = spawnSync(cmd, args, {
    shell,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    ...opts,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Probe candidate launchers, return first one resolving to Python ≥ MIN_PY.
function detectPython() {
  const candidates =
    process.platform === 'win32'
      ? ['py -3.12', 'py -3.11', 'py -3', 'python3', 'python']
      : ['python3.12', 'python3.11', 'python3', 'python'];

  const tried = [];
  for (const c of candidates) {
    const r = run(c, ['--version'], { shell: true });
    const out = (r.stdout + r.stderr).trim();
    const m = out.match(/Python (\d+)\.(\d+)\.(\d+)/);
    if (r.code !== 0 || !m) {
      tried.push({ launcher: c, ok: false, output: out.slice(0, 100) });
      continue;
    }
    const [, maj, min] = m.map(Number);
    if (maj > MIN_PY_MAJOR || (maj === MIN_PY_MAJOR && min >= MIN_PY_MINOR)) {
      const vr = run(c, ['-m', 'venv', '--help'], { shell: true });
      if (vr.code !== 0) {
        tried.push({
          launcher: c, ok: false,
          output: `version ok (${maj}.${min}) but venv module missing`,
        });
        continue;
      }
      return { launcher: c, version: `${maj}.${min}.${m[3]}`, tried };
    }
    tried.push({ launcher: c, ok: false, output: `version too old: ${maj}.${min}` });
  }
  return { launcher: null, tried };
}

function venvPython(venvDir) {
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python');
}

function venvHealthy(venvDir) {
  const py = venvPython(venvDir);
  if (!existsSync(py)) return false;
  const r = run(py, ['--version']);
  if (r.code !== 0) return false;
  const m = (r.stdout + r.stderr).match(/Python (\d+)\.(\d+)/);
  if (!m) return false;
  const [, maj, min] = m.map(Number);
  return maj > MIN_PY_MAJOR || (maj === MIN_PY_MAJOR && min >= MIN_PY_MINOR);
}

// ---------------------------------------------------------------------------
// File-lock (Shared_Install_Architecture.md §7.3)
// ---------------------------------------------------------------------------

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = "are you there?", no actual signal sent
    return true;
  } catch (err) {
    // ESRCH → no such process; EPERM → exists but we can't signal it. Both
    // count as alive for our stale-detection purposes (we treat EPERM as alive
    // to be conservative — don't yank a lock from a privileged process).
    return err.code === 'EPERM';
  }
}

function readLockMeta(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Try to acquire $shared_module_dir/.install.lock.
 * @returns the lock path (caller must release via releaseLock).
 * @throws if another process is actively holding the lock.
 */
function acquireLock(sharedModuleDir) {
  const lockPath = join(sharedModuleDir, '.install.lock');
  mkdirSync(sharedModuleDir, { recursive: true });
  const meta = JSON.stringify({ pid: process.pid, ts: Date.now() });

  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, meta);
    closeSync(fd);
    return lockPath;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Lock exists — check stale.
    const existing = readLockMeta(lockPath);
    const age = existing && existing.ts ? Date.now() - existing.ts : Infinity;
    const stale = age > LOCK_STALE_MS || !isProcessAlive(existing?.pid);
    if (!stale) {
      throw new Error(
        `Another install is in progress (lock pid=${existing?.pid}, age=${Math.round(age/1000)}s, ` +
        `path=${lockPath}). Wait and retry, or remove the lock if the holder crashed.`
      );
    }
    // Stale: overwrite.
    writeFileSync(lockPath, meta);
    return lockPath;
  }
}

function releaseLock(lockPath) {
  try { unlinkSync(lockPath); } catch { /* idempotent */ }
}

// ---------------------------------------------------------------------------
// v0.4.0 — torch variant selection
// ---------------------------------------------------------------------------

// Probe NVIDIA GPU via nvidia-smi. 5s timeout to keep install responsive
// when nvidia-smi is on PATH but the driver wedged (rare but reported).
// Returns { ok: true, gpus: ['NVIDIA GeForce RTX 3070 Laptop GPU', ...] }
// or { ok: false, reason: 'enoent'|'exit_nonzero'|'timeout'|'no_output' }.
function probeNvidiaSmi(_probe) {
  if (typeof _probe === 'function') return _probe(); // test injection
  const r = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error && r.error.code === 'ENOENT') return { ok: false, reason: 'enoent' };
  if (r.error && r.error.code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' };
  if (r.status !== 0) return { ok: false, reason: 'exit_nonzero', stderr: (r.stderr || '').slice(0, 300) };
  const gpus = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (gpus.length === 0) return { ok: false, reason: 'no_output' };
  return { ok: true, gpus };
}

// Walk vault and count *.md files (excluding deny dirs). Used for size estimate
// in needs_torch_decision payload — gives skill concrete numbers per current vault.
function countVaultNotes(vaultRoot) {
  const DENY = new Set(['.obsidian', '.claude', '.git', 'attachments', '.shared-tools', 'node_modules']);
  let count = 0;
  const stack = [vaultRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (DENY.has(ent.name)) continue;
        stack.push(join(dir, ent.name));
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        count += 1;
      }
    }
  }
  return count;
}

// Compute rough reindex time estimate for a given note count.
// Returns minutes, rounded to nearest. Lower bound 1 (warmup-dominated tiny vaults).
function estimateReindexMinutes(noteCount, variant) {
  if (!Number.isFinite(noteCount) || noteCount <= 0) return null;
  const perNote = variant === TORCH_CUDA_VARIANT_TAG
    ? PERF_HINT.cuda_sec_per_note
    : PERF_HINT.cpu_sec_per_note;
  const warmup = variant === TORCH_CUDA_VARIANT_TAG ? PERF_HINT.cuda_warmup_sec : 5;
  const sec = noteCount * perNote + warmup;
  return Math.max(1, Math.round(sec / 60));
}

// Read prior installed torch variant from per-vault marker. Returns null if no
// marker or no torch_variant field (pre-v0.4.0 markers don't have it).
function readPriorTorchVariant(perVaultMarkerPath) {
  if (!existsSync(perVaultMarkerPath)) return null;
  try {
    const data = JSON.parse(readFileSync(perVaultMarkerPath, 'utf-8'));
    return typeof data.torch_variant === 'string' ? data.torch_variant : null;
  } catch {
    return null;
  }
}

// v0.4.1 — read torch_variant from shared `.installed` marker. The shared venv
// is one-per-machine across all vaults; this tells us what variant other
// vaults are currently using. Differs from readPriorTorchVariant (per-vault).
// Returns null if marker missing, malformed, or pre-v0.4.0 (no torch_variant).
function readSharedTorchVariant(sharedMarkerPath) {
  if (!existsSync(sharedMarkerPath)) return null;
  try {
    const data = JSON.parse(readFileSync(sharedMarkerPath, 'utf-8'));
    return typeof data.torch_variant === 'string' ? data.torch_variant : null;
  } catch {
    return null;
  }
}

// v0.4.1 — walk ~/.claude.json to find all projects that have a
// vault-semantic mcpServer registered. These are the vaults that share the
// venv; informational for the conflict prompt.
// Returns array of project paths (strings). Empty if config missing or
// malformed.
function listRegisteredVaultSemanticProjects() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return [];
  const cfgPath = join(home, '.claude.json');
  if (!existsSync(cfgPath)) return [];
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const projects = cfg.projects || {};
    return Object.entries(projects)
      .filter(([, proj]) => proj && proj.mcpServers && proj.mcpServers['vault-semantic'])
      .map(([path]) => path);
  } catch {
    return [];
  }
}

// Detect installed torch variant by inspecting `torch.__version__` in the
// venv python. Returns 'cuda_cu126', 'cpu', or null if torch not installed
// / venv broken. Drift detection: compare with target variant; if mismatch
// → swap torch in ensureVenvAndInstall.
function detectInstalledTorchVariant(venvDir) {
  const py = venvPython(venvDir);
  if (!existsSync(py)) return null;
  const r = run(py, ['-c', 'import torch; print(torch.__version__)']);
  if (r.code !== 0) return null;
  const ver = (r.stdout || '').trim();
  if (!ver) return null;
  if (ver.includes('+cu126')) return TORCH_CUDA_VARIANT_TAG;
  if (ver.includes('+cu')) return `cuda_${ver.split('+')[1]}`; // other CUDA wheel sneaked in
  return TORCH_CPU_VARIANT_TAG; // bare "2.12.0" or "+cpu" both mean CPU build
}

// Build needs_torch_decision payload — emitted when device=auto, GPU detected,
// and no prior decision recorded. Skill uses fields to show concrete trade-off.
//
// Recommendation logic accounts for shared venv state:
//   - If shared marker already records a torch_variant, recommend that one —
//     picking the other forces a swap_consent dance that almost always ends in
//     re-aligning to shared anyway (path B). Aligning up front skips the
//     friction and avoids dragging cross-vault consumers through a torch swap.
//   - If no shared marker yet (this vault is the first install on the machine),
//     recommend CUDA for any non-trivial vault (>25 notes) since the speedup
//     (~5x) dominates the +2.3 GB shared disk cost. For tiny vaults (≤25 notes)
//     CPU is reasonable — the speedup absolute saving is small.
function pickRecommendedVariant({ shared_torch_variant, note_count }) {
  if (shared_torch_variant === TORCH_CPU_VARIANT_TAG) return TORCH_CPU_VARIANT_TAG;
  if (shared_torch_variant === TORCH_CUDA_VARIANT_TAG) return TORCH_CUDA_VARIANT_TAG;
  return note_count > 25 ? TORCH_CUDA_VARIANT_TAG : TORCH_CPU_VARIANT_TAG;
}

function buildNeedsTorchDecisionPayload({ gpus, vault_root, shared_module_dir, actions, warnings }) {
  const note_count = countVaultNotes(vault_root);
  const sharedMarkerPath = join(shared_module_dir, '.installed');
  const shared_torch_variant = readSharedTorchVariant(sharedMarkerPath);
  const recommended_variant = pickRecommendedVariant({ shared_torch_variant, note_count });
  const recommendation_reason =
    shared_torch_variant
      ? `shared venv already uses ${shared_torch_variant} — picking the same avoids a torch swap that affects other vaults`
      : note_count > 25
        ? 'no shared install yet; CUDA gives ~5x reindex speedup on non-trivial vault'
        : 'no shared install yet; tiny vault — CPU saves ~2.3 GB shared disk for negligible time difference';
  return {
    status: 'needs_torch_decision',
    message:
      `NVIDIA GPU detected (${gpus.join(', ')}) and no prior torch variant choice on record. ` +
      `vault-semantic install paused — set manifest config.vault-semantic.device to 'cpu' or 'cuda', then re-run.`,
    actions,
    warnings,
    next_steps: [
      'Прочитай поля decision.* и спроси пользователя, какой вариант ставить (см. SKILL.md Шаг 6.x).',
      'Запиши выбор в `.claude/vault-manifest.yaml::config.vault-semantic.device` как `cpu` или `cuda`.',
      'Перезапусти /init-vault --module vault-semantic.',
    ],
    module_status: 'awaiting_user_decision',
    install_scope: 'shared',
    decision: {
      kind: 'torch_variant',
      gpu_detected: gpus,
      vault_note_count: note_count,
      shared_torch_variant,
      recommended_variant,
      recommendation_reason,
      options: {
        cpu: {
          torch_variant: TORCH_CPU_VARIANT_TAG,
          torch_wheel_mb: 200,
          venv_total_gb: PERF_HINT.cpu_disk_gb,
          est_first_reindex_min: estimateReindexMinutes(note_count, TORCH_CPU_VARIANT_TAG),
          sec_per_note: PERF_HINT.cpu_sec_per_note,
        },
        cuda: {
          torch_variant: TORCH_CUDA_VARIANT_TAG,
          torch_wheel_mb: 2600,
          venv_total_gb: PERF_HINT.cuda_disk_gb,
          est_first_reindex_min: estimateReindexMinutes(note_count, TORCH_CUDA_VARIANT_TAG),
          sec_per_note: PERF_HINT.cuda_sec_per_note,
        },
      },
      measured_on: PERF_HINT.measured_on,
      note:
        'Estimate based on measured reindex on RTX 3070 Laptop / cp314+cu126. ' +
        'Real speedup varies with GPU class — faster GPUs hit CPU-bound chunking/sqlite ceiling sooner. ' +
        'Incremental refresh (post-first-reindex) is fast in both variants — only first install pays the full cost.',
    },
  };
}

// ---------------------------------------------------------------------------
// venv + pip orchestration (shared between scopes)
// ---------------------------------------------------------------------------

function ensureVenvAndInstall({ venvDir, srcDir, torch_variant, actions, warnings }) {
  // D22 audit: log entry point + the existsSync verdict that determines branching.
  // sharedModuleDir is venvDir's parent for shared scope; for per-vault it's mcpDir
  // (still uniquely identifies which install).
  const auditFile = venvAuditPath(venvDir.replace(/[/\\]\.venv$/, ''));
  logVenvOp(auditFile, 'ensureVenvAndInstall_entry', {
    venvDir,
    srcDir,
    torch_variant: torch_variant || null,
    venv_exists: existsSync(venvDir),
  });

  // Detect or reuse venv.
  let launcher = null, pythonVersion = null;
  if (!existsSync(venvDir)) {
    const detect = detectPython();
    if (!detect.launcher) {
      fail(
        `Python ≥${MIN_PY_MAJOR}.${MIN_PY_MINOR} not found. Probed: ${detect.tried.map(t => t.launcher).join(', ')}. ` +
        `Install Python 3.11+ (https://python.org) and ensure it's on PATH.`,
        { module_status: 'missing_prerequisite', detection: detect.tried },
      );
    }
    launcher = detect.launcher;
    pythonVersion = detect.version;
    actions.push({ type: 'python_detected', launcher, version: pythonVersion });

    actions.push({ type: 'venv_create_start', target: venvDir });
    logVenvOp(auditFile, 'python_dash_m_venv_invoke', { venvDir, launcher, branch: 'create_new' });
    const r = run(launcher, ['-m', 'venv', venvDir], { shell: true });
    logVenvOp(auditFile, 'python_dash_m_venv_done', { venvDir, exit_code: r.code, branch: 'create_new' });
    if (r.code !== 0) {
      fail(`venv creation failed (exit ${r.code}): ${r.stderr.slice(-500)}`, { actions, warnings });
    }
    actions.push({ type: 'venv_created', target: venvDir });
  } else if (!venvHealthy(venvDir)) {
    warnings.push({
      type: 'venv_unhealthy',
      message: 'Existing .venv/ does not respond — host Python may have been replaced. Recreating.',
    });
    logVenvOp(auditFile, 'venv_rm_unhealthy', { venvDir });
    rmSync(venvDir, { recursive: true, force: true });
    const detect = detectPython();
    if (!detect.launcher) {
      fail(`Python not available for venv recreate. Tried: ${detect.tried.map(t => t.launcher).join(', ')}.`,
        { actions, warnings });
    }
    launcher = detect.launcher;
    pythonVersion = detect.version;
    logVenvOp(auditFile, 'python_dash_m_venv_invoke', { venvDir, launcher, branch: 'recreate_unhealthy' });
    const r = run(launcher, ['-m', 'venv', venvDir], { shell: true });
    logVenvOp(auditFile, 'python_dash_m_venv_done', { venvDir, exit_code: r.code, branch: 'recreate_unhealthy' });
    if (r.code !== 0) {
      fail(`venv recreation failed (exit ${r.code}): ${r.stderr.slice(-500)}`, { actions, warnings });
    }
    actions.push({ type: 'venv_recreated', target: venvDir });
  } else {
    logVenvOp(auditFile, 'venv_verified', { venvDir });
    actions.push({ type: 'venv_verified', target: venvDir });
    // Read python version from the venv binary for marker freshness.
    const r = run(venvPython(venvDir), ['--version']);
    const m = (r.stdout + r.stderr).match(/Python (\d+\.\d+\.\d+)/);
    if (m) pythonVersion = m[1];
  }

  const py = venvPython(venvDir);

  // pip upgrade (idempotent, fast hit).
  {
    const r = run(py, ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet']);
    if (r.code !== 0) {
      warnings.push({
        type: 'pip_upgrade_failed',
        message: `pip --upgrade returned ${r.code}: ${r.stderr.slice(-200)}. Continuing with bundled pip.`,
      });
    } else {
      actions.push({ type: 'pip_upgraded' });
    }
  }

  // Editable install of the in-tree package. v0.4.0: pass --extra-index-url
  // for CUDA torch variant so pip resolves cu126 wheels instead of default
  // CPU torch from PyPI.
  {
    actions.push({ type: 'pip_install_start', target: srcDir, torch_variant });
    const pipArgs = ['-m', 'pip', 'install', '-e', srcDir, '--no-cache-dir', '--quiet'];
    if (torch_variant === TORCH_CUDA_VARIANT_TAG) {
      pipArgs.push('--extra-index-url', TORCH_CUDA_INDEX);
    }
    const r = run(py, pipArgs);
    if (r.code !== 0) {
      fail(`pip install -e failed (exit ${r.code}): ${r.stderr.slice(-800)}`, { actions, warnings });
    }
    actions.push({ type: 'pip_install_done', target: srcDir, torch_variant });
  }

  // v0.4.0 — drift detection: if installed torch variant differs from target,
  // force-reinstall torch with the right index. Triggers on manifest device
  // override changes (cpu↔cuda) after first install.
  {
    const installed_variant = detectInstalledTorchVariant(venvDir);
    if (installed_variant && torch_variant && installed_variant !== torch_variant) {
      actions.push({ type: 'torch_variant_drift', installed: installed_variant, target: torch_variant });
      const reinstallArgs = ['-m', 'pip', 'install', '--no-cache-dir', '--force-reinstall', '--quiet', 'torch'];
      if (torch_variant === TORCH_CUDA_VARIANT_TAG) {
        reinstallArgs.splice(reinstallArgs.length - 1, 0, '--index-url', TORCH_CUDA_INDEX);
      } else {
        // Force CPU build: PyPI default doesn't always give +cpu suffix; explicit cpu index.
        reinstallArgs.splice(reinstallArgs.length - 1, 0, '--index-url', 'https://download.pytorch.org/whl/cpu');
      }
      const r = run(py, reinstallArgs);
      if (r.code !== 0) {
        fail(`torch variant swap failed (exit ${r.code}): ${r.stderr.slice(-800)}`,
          { actions, warnings, module_status: 'torch_swap_failed' });
      }
      actions.push({ type: 'torch_swap_done', new_variant: torch_variant });
    } else if (installed_variant) {
      actions.push({ type: 'torch_variant_verified', variant: installed_variant });
    }
  }

  // Smoke import (file-based; argv quoting issues on Windows for -c).
  {
    const smokePath = join(srcDir, '_smoke.py');
    writeFileSync(smokePath, 'import vault_semantic\nprint(vault_semantic.__version__)\n');
    const r = run(py, [smokePath]);
    try { rmSync(smokePath); } catch {}
    if (r.code !== 0) {
      fail(`Smoke import failed: ${r.stderr.slice(-500)}`, { actions, warnings });
    }
    actions.push({ type: 'smoke_test_ok', detail: r.stdout.trim() });
  }

  return { python_version: pythonVersion };
}

// ---------------------------------------------------------------------------
// Skills installation (per-vault — even for shared-scope MCP, skills are
// vault-local in .claude/skills/).
// ---------------------------------------------------------------------------

function listModuleSkills(moduleDir) {
  const skillsDir = join(moduleDir, 'skills');
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .filter((name) => statSync(join(skillsDir, name)).isDirectory())
    .sort();
}

function readSkillMarker(skillDir) {
  const p = join(skillDir, SKILL_MARKER);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

function writeSkillMarker(skillDir, version) {
  const data = {
    module: MODULE_NAME,
    version,
    installed_at: new Date().toISOString(),
  };
  writeFileSync(join(skillDir, SKILL_MARKER), JSON.stringify(data, null, 2));
}

function installSkills({ vault_root, module_dir, version, actions, warnings, next_steps }) {
  const skillNames = listModuleSkills(module_dir);
  if (skillNames.length === 0) return; // no skills shipped — silent skip

  const skillsTargetDir = join(vault_root, '.claude', 'skills');
  if (!existsSync(skillsTargetDir)) {
    mkdirSync(skillsTargetDir, { recursive: true });
    actions.push({ type: 'directory_created', target: '.claude/skills/' });
  }

  let installed = 0, updated = 0, upToDate = 0;
  const skipped = [];

  for (const skill of skillNames) {
    const srcDir = join(module_dir, 'skills', skill);
    const destDir = join(skillsTargetDir, skill);

    if (!existsSync(destDir)) {
      cpSync(srcDir, destDir, { recursive: true });
      writeSkillMarker(destDir, version);
      actions.push({ type: 'skill_installed', skill, mode: 'fresh' });
      installed += 1;
      continue;
    }

    const marker = readSkillMarker(destDir);
    if (!marker) {
      warnings.push({
        type: 'skill_unmanaged',
        skill,
        message:
          `Skill ".claude/skills/${skill}/" already exists but has no .managed marker — ` +
          `treated as user-customized, skipped. Delete it manually if you want the framework version.`,
      });
      skipped.push(skill);
      continue;
    }

    if (marker.version === version && marker.module === MODULE_NAME) {
      upToDate += 1;
      continue;
    }

    // outdated managed → re-sync
    rmSync(destDir, { recursive: true, force: true });
    cpSync(srcDir, destDir, { recursive: true });
    writeSkillMarker(destDir, version);
    actions.push({
      type: 'skill_installed',
      skill,
      mode: 'updated',
      from_version: marker.version,
    });
    updated += 1;
  }

  if (skipped.length > 0) {
    next_steps.push(
      `Skipped unmanaged skills: ${skipped.join(', ')}. ` +
      `Delete .claude/skills/<name>/ manually and re-run /init-vault to install framework version.`
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const raw = readStdin();
  if (!raw.trim()) fail('Empty stdin — install handler expects JSON input.');

  let input;
  try { input = JSON.parse(raw); }
  catch (err) { fail(`Invalid stdin JSON: ${err.message}`); }

  const { vault_root, module_name, module_dir } = input;
  if (!vault_root || !module_dir) {
    fail('Missing required input fields: vault_root, module_dir.');
  }

  const install_scope = input.install_scope || 'per-vault';
  const actions = [];
  const warnings = [];
  const next_steps = [];

  if (install_scope === 'shared') {
    runSharedInstall({ input, actions, warnings, next_steps });
  } else {
    runPerVaultInstall({ input, actions, warnings, next_steps });
  }
}

function runSharedInstall({ input, actions, warnings, next_steps }) {
  const { vault_root, module_name, module_dir } = input;
  const shared_module_dir = input.shared_module_dir;
  const source_sha = input.source_sha;
  const version = input.version || readModuleVersion(module_dir);

  if (!shared_module_dir) {
    fail('install_scope=shared requires `shared_module_dir` in stdin. /init-vault skill is responsible for resolving it via core/lib/shared_install.mjs.');
  }
  if (!source_sha) {
    fail('install_scope=shared requires `source_sha` in stdin. /init-vault skill should pass the value returned by core/lib/shared_install.mjs.');
  }

  // Source must already be in place — skill invokes shared_install.mjs first.
  const sharedSrc = join(shared_module_dir, 'mcp');
  if (!existsSync(join(sharedSrc, 'pyproject.toml'))) {
    fail(
      `Shared source not provisioned at ${sharedSrc}/pyproject.toml. ` +
      `The /init-vault skill must run core/lib/shared_install.mjs before this handler. ` +
      `If you invoked install.mjs directly, run shared_install.mjs CLI first.`,
      { module_status: 'missing_prerequisite' },
    );
  }
  actions.push({ type: 'shared_source_verified', target: sharedSrc });

  // v0.4.5 — deploy Node shim (Phase 4.7 transport) into shared root.
  // module.yaml::provides.mcp_server.args references {shared_module_dir}/shim/
  // index.mjs, but core/lib/shared_install.mjs::provisionSharedRoot only copies
  // the mcp/ subdir (its single-tree contract). shim/ is a sibling to mcp/ in
  // the bootstrap module; it has to be deployed here. Without this, harness
  // D8 binary_missing detection (correctly) refuses to register vault-semantic
  // — observed 2026-05-21 on a fresh first_install in a third-party vault.
  //
  // Idempotent: cpSync with force overwrites if shim/index.mjs changed in
  // bootstrap (so refresh_source / version_bump pull the latest shim too —
  // closes the silent-staleness loophole where pre-v0.4.5 shared roots had
  // shim frozen from initial Phase 4.7 hand-deploy).
  {
    const srcShim = join(module_dir, 'shim');
    const dstShim = join(shared_module_dir, 'shim');
    if (existsSync(join(srcShim, 'index.mjs'))) {
      mkdirSync(dstShim, { recursive: true });
      cpSync(srcShim, dstShim, { recursive: true, force: true });
      actions.push({ type: 'shim_deployed', source: srcShim, target: dstShim });
    } else {
      // module.yaml references shim/, but bootstrap module has none — config
      // bug. Don't silently continue: harness will fail with binary_missing
      // later anyway, surface root cause now.
      fail(
        `shim/index.mjs missing in bootstrap module at ${srcShim}. ` +
        `module.yaml::provides.mcp_server.args references {shared_module_dir}/shim/index.mjs — ` +
        `bootstrap copy is incomplete. Check vault-bootstrap repo integrity.`,
        { module_status: 'missing_prerequisite', actions, warnings },
      );
    }
  }

  // v0.4.0 — resolve torch variant before any heavy ops.
  // config.device: 'auto'|'cpu'|'cuda'. Default 'auto'.
  // 'auto' resolution priority:
  //   1. Prior decision from per-vault .installed{torch_variant} — stable choice across re-installs.
  //   2. Probe nvidia-smi:
  //        no GPU → silent CPU (no prompt — there's no decision to make).
  //        GPU detected + no prior choice → emit needs_torch_decision, exit early.
  //   3. Explicit 'cpu' or 'cuda' bypass probe entirely.
  const perVaultMarker = join(module_dir, '.installed');
  const device_setting = (input.config && input.config.device) || 'auto';
  const prior_variant = readPriorTorchVariant(perVaultMarker);

  let torch_variant;
  if (device_setting === 'cpu') {
    torch_variant = TORCH_CPU_VARIANT_TAG;
    actions.push({ type: 'torch_variant_resolved', source: 'manifest', device_setting, torch_variant });
  } else if (device_setting === 'cuda') {
    torch_variant = TORCH_CUDA_VARIANT_TAG;
    actions.push({ type: 'torch_variant_resolved', source: 'manifest', device_setting, torch_variant });
  } else if (device_setting === 'auto') {
    if (prior_variant) {
      torch_variant = prior_variant;
      actions.push({ type: 'torch_variant_resolved', source: 'prior_marker', device_setting, torch_variant });
    } else {
      const probe = probeNvidiaSmi(input._probe_nvidia_smi);
      actions.push({ type: 'nvidia_smi_probe', ok: probe.ok, reason: probe.reason || null, gpus: probe.gpus || [] });
      if (probe.ok) {
        // GPU detected, no prior choice → ask user.
        const payload = buildNeedsTorchDecisionPayload({
          gpus: probe.gpus, vault_root, shared_module_dir, actions, warnings,
        });
        emit(payload);
        process.exit(0); // not an error — skill will handle decision routing
      }
      torch_variant = TORCH_CPU_VARIANT_TAG;
      actions.push({ type: 'torch_variant_resolved', source: 'auto_no_gpu', device_setting, torch_variant });
    }
  } else {
    fail(`Invalid config.device value: ${JSON.stringify(device_setting)}. Expected 'auto', 'cpu', or 'cuda'.`,
      { module_status: 'invalid_config' });
  }

  // v0.4.1 — shared variant conflict guard. The shared venv is one-per-machine
  // across all vaults; swapping torch affects every vault using this install.
  // If shared marker already records a torch_variant that differs from the
  // target, refuse to swap unless the caller passes `_allow_torch_swap: true`
  // (skill sets this after explicit user consent).
  const sharedMarkerPath = join(shared_module_dir, '.installed');
  const shared_variant = readSharedTorchVariant(sharedMarkerPath);
  if (shared_variant && shared_variant !== torch_variant && !input._allow_torch_swap) {
    const other_projects = listRegisteredVaultSemanticProjects()
      .filter((p) => p !== vault_root);
    emit({
      status: 'needs_shared_torch_swap_consent',
      message:
        `Shared venv currently on torch variant "${shared_variant}", this vault requests "${torch_variant}". ` +
        `Swapping torch in the shared venv affects all vaults using it (one venv per machine). ` +
        `Skill must obtain explicit user consent before retrying with _allow_torch_swap=true.`,
      actions,
      warnings,
      next_steps: [
        'См. SKILL.md Шаг 6.1.2 — purpose, options, и как перезапустить с _allow_torch_swap: true.',
      ],
      module_status: 'awaiting_user_decision',
      install_scope: 'shared',
      conflict: {
        kind: 'shared_torch_variant',
        current_shared_variant: shared_variant,
        requested_variant: torch_variant,
        shared_marker_path: sharedMarkerPath,
        requesting_vault: vault_root,
        other_registered_projects: other_projects,
        swap_cost_min: torch_variant === TORCH_CUDA_VARIANT_TAG ? 7 : 3,
        note:
          'Swap re-downloads torch wheel (~2.6 GB for CUDA, ~200 MB for CPU) and re-runs pip --force-reinstall. ' +
          'Other vaults will continue working, but their reindex performance changes (CUDA → CPU = slower, CPU → CUDA = faster). ' +
          'Alternative: switch this vault\'s manifest config.vault-semantic.device to match the shared variant.',
      },
    });
    process.exit(0);
  }

  // Acquire lock (mkdir handled inside).
  let lockPath;
  try {
    lockPath = acquireLock(shared_module_dir);
    actions.push({ type: 'lock_acquired', target: lockPath });
  } catch (err) {
    fail(err.message, { module_status: 'busy' });
  }

  try {
    // Venv + pip install -e against shared source.
    const venvDir = join(shared_module_dir, '.venv');
    const { python_version } = ensureVenvAndInstall({ venvDir, srcDir: sharedSrc, torch_variant, actions, warnings });

    // Write shared marker.
    const sharedMarker = join(shared_module_dir, '.installed');
    writeFileSync(sharedMarker, JSON.stringify({
      version,
      source_sha,
      installed_at: new Date().toISOString(),
      python_version,
      torch_variant,
    }, null, 2));
    actions.push({ type: 'shared_marker_written', target: sharedMarker, version });

    // Per-vault: ensure data dir + marker. NEVER write into shared root for vault state.
    const perVaultData = join(module_dir, 'data');
    mkdirSync(perVaultData, { recursive: true });
    actions.push({ type: 'per_vault_data_dir_ready', target: perVaultData });

    writeFileSync(perVaultMarker, JSON.stringify({
      version,
      linked_to: shared_module_dir,
      registered_at: new Date().toISOString(),
      torch_variant,
    }, null, 2));
    actions.push({ type: 'per_vault_marker_written', target: perVaultMarker });

    // Skills (L3 — vault-rag и любые будущие).
    installSkills({ vault_root, module_dir, version, actions, warnings, next_steps });

    // Sub-block in CLAUDE.md.
    const claudeMdPath = join(vault_root, SUB_BLOCK_TARGET);
    if (!existsSync(claudeMdPath)) {
      fail(`${SUB_BLOCK_TARGET} not found — install \`core\` module first.`,
        { module_status: 'missing_prerequisite' });
    }
    const fragment = loadFragment(module_dir, 'claude-md.fragment');
    const sb = ensureSubBlock(claudeMdPath, MODULE_NAME, fragment);
    if (sb.changed) actions.push({ type: 'sub_block', target: SUB_BLOCK_TARGET, action: sb.action });

    next_steps.push(
      `Shared install root: ${shared_module_dir}`,
      'Запустите harness-claude-code install (или /init-vault), чтобы зарегистрировать MCP-сервер в ~/.claude.json для этого волта.',
      'После регистрации и рестарта Claude Code — попросите Claude проиндексировать волт (например: «проиндексируй волт»).',
    );

    emit({
      status: 'ok',
      message: `Module "${module_name}" installed (shared scope, v${version}).`,
      actions,
      warnings,
      next_steps,
      module_status: 'installed',
      install_scope: 'shared',
      shared_module_dir,
    });
  } finally {
    releaseLock(lockPath);
  }
}

function runPerVaultInstall({ input, actions, warnings, next_steps }) {
  const { vault_root, module_name, module_dir } = input;

  // 1. Verify mcp/ source layout.
  const mcpDir = join(module_dir, 'mcp');
  const pyproject = join(mcpDir, 'pyproject.toml');
  if (!existsSync(pyproject)) {
    fail(
      `Source not found: ${pyproject}. Module bundle is incomplete. ` +
      `Re-copy modules/vault-semantic/ from vault-bootstrap.`,
      { module_status: 'missing_prerequisite' },
    );
  }
  actions.push({ type: 'source_verified', target: 'mcp/pyproject.toml' });

  // 2. Venv + pip install. v0.4.0 torch variant: per-vault is the legacy path —
  // no needs_torch_decision flow here. config.device='auto' defaults to CPU
  // silently. Power users wanting CUDA per-vault must set device:cuda explicitly.
  const device_setting = (input.config && input.config.device) || 'auto';
  const torch_variant = device_setting === 'cuda' ? TORCH_CUDA_VARIANT_TAG : TORCH_CPU_VARIANT_TAG;
  actions.push({ type: 'torch_variant_resolved', source: 'per_vault_simple', device_setting, torch_variant });
  const venvDir = join(mcpDir, '.venv');
  ensureVenvAndInstall({ venvDir, srcDir: mcpDir, torch_variant, actions, warnings });

  // 2.5. Skills (L3 — vault-rag и любые будущие).
  const version = readModuleVersion(module_dir);
  installSkills({ vault_root, module_dir, version, actions, warnings, next_steps });

  // 3. Sub-block.
  const claudeMdPath = join(vault_root, SUB_BLOCK_TARGET);
  if (!existsSync(claudeMdPath)) {
    fail(`${SUB_BLOCK_TARGET} not found — install \`core\` module first.`,
      { module_status: 'missing_prerequisite' });
  }
  const fragment = loadFragment(module_dir, 'claude-md.fragment');
  const sb = ensureSubBlock(claudeMdPath, MODULE_NAME, fragment);
  if (sb.changed) actions.push({ type: 'sub_block', target: SUB_BLOCK_TARGET, action: sb.action });

  // 4. Marker.
  const marker = join(module_dir, '.installed');
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({
    version,
    installed_at: new Date().toISOString(),
    torch_variant,
  }, null, 2));
  actions.push({ type: 'marker_written', target: '.installed', version });

  next_steps.push(
    'Запустите harness-claude-code install (или /init-vault), чтобы зарегистрировать MCP-сервер в ~/.claude.json.',
  );

  emit({
    status: 'ok',
    message: `Module "${module_name}" installed (per-vault scope, v${version}).`,
    actions,
    warnings,
    next_steps,
    module_status: 'installed',
    install_scope: 'per-vault',
  });
}

try { main(); }
catch (err) { fail(`Unhandled error: ${err.message}\n${err.stack}`); }
