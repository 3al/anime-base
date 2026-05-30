#!/usr/bin/env node
// skills-common module — status handler.
//
// Read-only. Reports per-skill state (managed_current / managed_outdated / unmanaged / missing).
// Module-level status: installed | outdated | partial | missing.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin } from '../../core/lib/read_input.mjs';

const MODULE_NAME = 'skills-common';
const MARKER_NAME = '.managed';
const SUB_BLOCK_TARGET = 'CLAUDE.md';


function emit(result) {
  process.stdout.write(JSON.stringify(result, null, 2));
}

function readModuleVersion(moduleDir) {
  const p = join(moduleDir, 'module.yaml');
  if (!existsSync(p)) return 'unknown';
  const m = readFileSync(p, 'utf-8').match(/^version:\s*(.+)$/m);
  return m ? m[1].trim() : 'unknown';
}

function readInstalledVersion(moduleDir) {
  const p = join(moduleDir, '.installed');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')).version;
  } catch {
    return null;
  }
}

function listModuleSkills(moduleDir) {
  const skillsDir = join(moduleDir, 'skills');
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .filter((name) => statSync(join(skillsDir, name)).isDirectory())
    .sort();
}

function readManagedMarker(skillDir) {
  const path = join(skillDir, MARKER_NAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function hasSubBlock(filePath, moduleName) {
  if (!existsSync(filePath)) return false;
  const body = readFileSync(filePath, 'utf-8');
  return (
    body.includes(`<!-- BEGIN: module:${moduleName} -->`) &&
    body.includes(`<!-- END: module:${moduleName} -->`)
  );
}

function classifySkill(destDir, moduleVersion) {
  if (!existsSync(destDir)) return 'missing';
  const marker = readManagedMarker(destDir);
  if (!marker || marker.module !== MODULE_NAME) return 'unmanaged';
  if (marker.version !== moduleVersion) return 'managed_outdated';
  return 'managed_current';
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) {
    emit({ status: 'error', message: 'Empty stdin.', module_status: 'unknown' });
    process.exit(1);
  }

  const input = JSON.parse(raw);
  const { vault_root, module_dir } = input;

  const version_available = readModuleVersion(module_dir);
  const version_installed = readInstalledVersion(module_dir);

  const claudeMdPath = join(vault_root, SUB_BLOCK_TARGET);
  const skillsTargetDir = join(vault_root, '.claude', 'skills');

  const skillNames = listModuleSkills(module_dir);
  const perSkill = {};
  for (const skill of skillNames) {
    perSkill[skill] = classifySkill(join(skillsTargetDir, skill), version_available);
  }

  const components = {
    installed_marker: existsSync(join(module_dir, '.installed')),
    claude_md_subblock: hasSubBlock(claudeMdPath, MODULE_NAME),
    skills: perSkill,
  };

  const skillStates = Object.values(perSkill);
  const anyMissing = skillStates.some((s) => s === 'missing');
  const allCurrent = skillStates.every((s) => s === 'managed_current');

  let module_status;
  if (!components.installed_marker) {
    module_status = 'missing';
  } else if (version_installed !== version_available) {
    module_status = 'outdated';
  } else if (anyMissing || !components.claude_md_subblock || !allCurrent) {
    module_status = 'partial';
  } else {
    module_status = 'installed';
  }

  emit({
    status: 'ok',
    module_status,
    version_installed,
    version_available,
    components,
  });
}

try {
  main();
} catch (err) {
  emit({ status: 'error', message: err.message, module_status: 'unknown' });
  process.exit(1);
}
