#!/usr/bin/env node
// vault-semantic module — status handler.
//
// Branches on install_scope:
//   - shared:    checks $shared_module_dir/{mcp,.venv,.installed} + per-vault marker
//   - per-vault: legacy layout (everything under {module_dir}/mcp/)
//
// module_status semantics (both scopes):
//   missing   — per-vault marker absent
//   outdated  — installed version != module.yaml version
//   partial   — marker present but venv unhealthy / sub-block missing / shared marker missing
//   installed — all checks pass
//
// Contract: Vault_Bootstrap_Architecture.md §«Контракт операций → status»
// + Shared_Install_Architecture.md §8.

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const MODULE_NAME = 'vault-semantic';
const SKILL_MARKER = '.managed';

function readStdin() {
  try { return readFileSync(0, 'utf-8'); } catch { return ''; }
}

function emit(result) {
  process.stdout.write(JSON.stringify(result, null, 2));
}

function readModuleVersion(moduleDir) {
  const p = join(moduleDir, 'module.yaml');
  if (!existsSync(p)) return 'unknown';
  const m = readFileSync(p, 'utf-8').match(/^version:\s*(.+)$/m);
  return m ? m[1].trim() : 'unknown';
}

function readMarker(dir) {
  const p = join(dir, '.installed');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

function listModuleSkills(moduleDir) {
  const skillsDir = join(moduleDir, 'skills');
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .filter((name) => statSync(join(skillsDir, name)).isDirectory())
    .sort();
}

function probeSkills(vault_root, module_dir, expected_version) {
  // Returns { all_installed, stale, missing } describing per-vault skill state.
  const expected = listModuleSkills(module_dir);
  if (expected.length === 0) {
    return { all_installed: true, stale: [], missing: [], expected: [] };
  }
  const skillsTargetDir = join(vault_root, '.claude', 'skills');
  const missing = [];
  const stale = [];
  for (const skill of expected) {
    const dest = join(skillsTargetDir, skill);
    if (!existsSync(join(dest, 'SKILL.md'))) {
      missing.push(skill);
      continue;
    }
    const markerPath = join(dest, SKILL_MARKER);
    if (!existsSync(markerPath)) {
      // No marker → treated as user-customized (install skips). Not "missing" but flag as stale-from-manifest.
      stale.push({ skill, reason: 'unmanaged' });
      continue;
    }
    try {
      const m = JSON.parse(readFileSync(markerPath, 'utf-8'));
      if (m.module !== MODULE_NAME || m.version !== expected_version) {
        stale.push({ skill, reason: 'version_mismatch', installed_version: m.version });
      }
    } catch {
      stale.push({ skill, reason: 'marker_corrupt' });
    }
  }
  return {
    all_installed: missing.length === 0 && stale.length === 0,
    missing,
    stale,
    expected,
  };
}

function hasSubBlock(filePath, moduleName) {
  if (!existsSync(filePath)) return false;
  const body = readFileSync(filePath, 'utf-8');
  return (
    body.includes(`<!-- BEGIN: module:${moduleName} -->`) &&
    body.includes(`<!-- END: module:${moduleName} -->`)
  );
}

function venvPython(venvDir) {
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python');
}

function probeVenv(venvDir, srcDir) {
  const py = venvPython(venvDir);
  if (!existsSync(py)) return { ok: false, reason: 'binary_missing' };
  const probePath = join(srcDir, '_probe.py');
  writeFileSync(probePath, 'import vault_semantic\nprint(vault_semantic.__version__)\n');
  const r = spawnSync(py, [probePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  try { rmSync(probePath); } catch {}
  if (r.status !== 0) {
    return { ok: false, reason: 'import_failed', detail: (r.stderr || '').slice(-200) };
  }
  return { ok: true, package_version: (r.stdout || '').trim() };
}

function reportShared({ vault_root, module_dir, shared_module_dir }) {
  const claudeMdPath = join(vault_root, 'CLAUDE.md');
  const sharedSrc = join(shared_module_dir, 'mcp');
  const sharedVenv = join(shared_module_dir, '.venv');

  const components = {
    shared_root: shared_module_dir,
    shared_source_pyproject: existsSync(join(sharedSrc, 'pyproject.toml')),
    shared_venv_exists: existsSync(sharedVenv),
    shared_venv_healthy: false,
    shared_marker_present: existsSync(join(shared_module_dir, '.installed')),
    per_vault_marker_present: existsSync(join(module_dir, '.installed')),
    per_vault_data_dir: existsSync(join(module_dir, 'data')),
    package_version: null,
    claude_md_subblock: hasSubBlock(claudeMdPath, MODULE_NAME),
  };

  const warnings = [];

  if (components.shared_venv_exists) {
    const probe = probeVenv(sharedVenv, sharedSrc);
    components.shared_venv_healthy = probe.ok;
    components.package_version = probe.package_version || null;
    if (!probe.ok) {
      warnings.push({
        type: 'venv_unhealthy',
        message: `shared venv probe failed (${probe.reason}): ${probe.detail || ''}`.trim(),
      });
    }
  }

  const sharedMarker = readMarker(shared_module_dir);
  const perVaultMarker = readMarker(module_dir);
  const version_available = readModuleVersion(module_dir);
  const version_installed = perVaultMarker ? perVaultMarker.version : null;
  const shared_version = sharedMarker ? sharedMarker.version : null;
  const source_sha_installed = sharedMarker ? sharedMarker.source_sha : null;

  const skillsState = probeSkills(vault_root, module_dir, version_available);
  components.skills_expected = skillsState.expected;
  components.skills_missing = skillsState.missing;
  components.skills_stale = skillsState.stale;
  if (skillsState.missing.length > 0) {
    warnings.push({
      type: 'skills_missing',
      message: `Skills not installed in .claude/skills/: ${skillsState.missing.join(', ')}. Re-run /init-vault to install.`,
    });
  }
  if (skillsState.stale.length > 0) {
    warnings.push({
      type: 'skills_stale',
      message: `Skills with outdated marker: ${skillsState.stale.map(s => `${s.skill}(${s.reason})`).join(', ')}.`,
    });
  }

  // Cross-check: per-vault marker should point to the same shared_module_dir we resolved.
  if (perVaultMarker && perVaultMarker.linked_to && perVaultMarker.linked_to !== shared_module_dir) {
    warnings.push({
      type: 'shared_root_mismatch',
      message: `per-vault marker links to ${perVaultMarker.linked_to}, but harness resolved ${shared_module_dir}. ` +
               `$VAULT_TOOLS_HOME may have changed since install.`,
    });
  }

  let module_status;
  if (!components.per_vault_marker_present) {
    module_status = 'missing';
  } else if (version_installed !== version_available) {
    module_status = 'outdated';
  } else if (!components.shared_marker_present || shared_version !== version_available) {
    module_status = 'partial'; // per-vault registered but shared root not present/synced
  } else if (!components.shared_venv_healthy || !components.claude_md_subblock || !components.shared_source_pyproject) {
    module_status = 'partial';
  } else if (skillsState.missing.length > 0 || skillsState.stale.length > 0) {
    module_status = 'partial';
  } else {
    module_status = 'installed';
  }

  emit({
    status: 'ok',
    module_status,
    install_scope: 'shared',
    version_installed,
    version_available,
    shared_version,
    source_sha_installed,
    components,
    warnings,
  });
}

function reportPerVault({ vault_root, module_dir }) {
  const mcpDir = join(module_dir, 'mcp');
  const venvDir = join(mcpDir, '.venv');
  const claudeMdPath = join(vault_root, 'CLAUDE.md');

  const components = {
    source_pyproject: existsSync(join(mcpDir, 'pyproject.toml')),
    venv_exists: existsSync(venvDir),
    venv_healthy: false,
    package_version: null,
    installed_marker: existsSync(join(module_dir, '.installed')),
    claude_md_subblock: hasSubBlock(claudeMdPath, MODULE_NAME),
  };

  const warnings = [];

  if (components.venv_exists) {
    const probe = probeVenv(venvDir, mcpDir);
    components.venv_healthy = probe.ok;
    components.package_version = probe.package_version || null;
    if (!probe.ok) {
      warnings.push({
        type: 'venv_unhealthy',
        message: `venv probe failed (${probe.reason}): ${probe.detail || ''}`.trim(),
      });
    }
  }

  const marker = readMarker(module_dir);
  const version_available = readModuleVersion(module_dir);
  const version_installed = marker ? marker.version : null;

  const skillsState = probeSkills(vault_root, module_dir, version_available);
  components.skills_expected = skillsState.expected;
  components.skills_missing = skillsState.missing;
  components.skills_stale = skillsState.stale;
  if (skillsState.missing.length > 0) {
    warnings.push({
      type: 'skills_missing',
      message: `Skills not installed in .claude/skills/: ${skillsState.missing.join(', ')}.`,
    });
  }
  if (skillsState.stale.length > 0) {
    warnings.push({
      type: 'skills_stale',
      message: `Skills with outdated marker: ${skillsState.stale.map(s => `${s.skill}(${s.reason})`).join(', ')}.`,
    });
  }

  let module_status;
  if (!components.installed_marker) {
    module_status = 'missing';
  } else if (version_installed !== version_available) {
    module_status = 'outdated';
  } else if (!components.venv_healthy || !components.claude_md_subblock) {
    module_status = 'partial';
  } else if (skillsState.missing.length > 0 || skillsState.stale.length > 0) {
    module_status = 'partial';
  } else {
    module_status = 'installed';
  }

  emit({
    status: 'ok',
    module_status,
    install_scope: 'per-vault',
    version_installed,
    version_available,
    components,
    warnings,
  });
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) {
    emit({ status: 'error', message: 'Empty stdin.', module_status: 'unknown' });
    process.exit(1);
  }

  const input = JSON.parse(raw);
  const { vault_root, module_dir } = input;
  const install_scope = input.install_scope || 'per-vault';

  if (install_scope === 'shared') {
    if (!input.shared_module_dir) {
      emit({
        status: 'error',
        message: 'install_scope=shared requires shared_module_dir in stdin.',
        module_status: 'unknown',
      });
      process.exit(1);
    }
    reportShared({
      vault_root,
      module_dir,
      shared_module_dir: input.shared_module_dir,
    });
  } else {
    reportPerVault({ vault_root, module_dir });
  }
}

try { main(); }
catch (err) {
  emit({ status: 'error', message: err.message, module_status: 'unknown' });
  process.exit(1);
}
