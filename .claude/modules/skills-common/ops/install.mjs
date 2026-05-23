#!/usr/bin/env node
// skills-common module — install handler.
//
// Copies neutral skills from <module>/skills/ to <vault>/.claude/skills/.
// Each installed skill gets a .managed marker. Existing skills:
//   - .managed marker matches version → no-op
//   - .managed marker outdated → re-sync (delete + recopy)
//   - no .managed marker → SKIP with warning (user-customized)
//
// Contract: see SYSTEM/Vault_Bootstrap_Architecture.md → "Контракт операций".

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  cpSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { ensureSubBlock } from '../../core/lib/managed_block.mjs';

const MODULE_NAME = 'skills-common';
const MARKER_NAME = '.managed';
const SUB_BLOCK_TARGET = 'CLAUDE.md';

function readStdin() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

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
  const yamlPath = join(moduleDir, 'module.yaml');
  if (!existsSync(yamlPath)) return 'unknown';
  const match = readFileSync(yamlPath, 'utf-8').match(/^version:\s*(.+)$/m);
  return match ? match[1].trim() : 'unknown';
}

function loadFragment(moduleDir, name) {
  const path = join(moduleDir, 'templates', name);
  if (!existsSync(path)) {
    throw new Error(`Template fragment not found: ${path}`);
  }
  return readFileSync(path, 'utf-8');
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

function writeManagedMarker(skillDir, version) {
  const data = {
    module: MODULE_NAME,
    version,
    installed_at: new Date().toISOString(),
  };
  writeFileSync(join(skillDir, MARKER_NAME), JSON.stringify(data, null, 2));
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) fail('Empty stdin — install handler expects JSON input.');

  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    fail(`Invalid stdin JSON: ${err.message}`);
  }

  const { vault_root, module_name, module_dir } = input;
  if (!vault_root || !module_dir) {
    fail('Missing required input fields: vault_root, module_dir.');
  }

  const actions = [];
  const warnings = [];
  const next_steps = [];

  // 1. Verify CLAUDE.md exists (core must be installed first).
  const claudeMdPath = join(vault_root, SUB_BLOCK_TARGET);
  if (!existsSync(claudeMdPath)) {
    fail(`${SUB_BLOCK_TARGET} not found — install \`core\` module first.`, {
      module_status: 'missing_prerequisite',
    });
  }

  // 2. Ensure .claude/skills/ exists in vault.
  const skillsTargetDir = join(vault_root, '.claude', 'skills');
  if (!existsSync(skillsTargetDir)) {
    mkdirSync(skillsTargetDir, { recursive: true });
    actions.push({ type: 'directory_created', target: '.claude/skills/' });
  }

  // 3. Install each skill.
  const version = readModuleVersion(module_dir);
  const skillNames = listModuleSkills(module_dir);

  if (skillNames.length === 0) {
    fail('No skills found in module skills/ directory.', {
      module_status: 'missing_prerequisite',
    });
  }

  let installed = 0;
  let updated = 0;
  let upToDate = 0;
  const skipped = [];

  for (const skill of skillNames) {
    const srcDir = join(module_dir, 'skills', skill);
    const destDir = join(skillsTargetDir, skill);

    if (!existsSync(destDir)) {
      cpSync(srcDir, destDir, { recursive: true });
      writeManagedMarker(destDir, version);
      actions.push({ type: 'skill_installed', skill, mode: 'fresh' });
      installed += 1;
      continue;
    }

    const marker = readManagedMarker(destDir);
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
    writeManagedMarker(destDir, version);
    actions.push({
      type: 'skill_installed',
      skill,
      mode: 'updated',
      from_version: marker.version,
    });
    updated += 1;
  }

  // 4. CLAUDE.md sub-block.
  const fragment = loadFragment(module_dir, 'claude-md.fragment');
  const sb = ensureSubBlock(claudeMdPath, MODULE_NAME, fragment);
  if (sb.changed) {
    actions.push({ type: 'sub_block', target: SUB_BLOCK_TARGET, action: sb.action });
  }

  // 5. Write .installed marker.
  const installedMarker = join(module_dir, '.installed');
  mkdirSync(dirname(installedMarker), { recursive: true });
  writeFileSync(
    installedMarker,
    JSON.stringify({ version, installed_at: new Date().toISOString() }, null, 2),
  );
  actions.push({ type: 'marker_written', target: '.installed', version });

  if (skipped.length > 0) {
    next_steps.push(
      `Skipped unmanaged skills: ${skipped.join(', ')}. ` +
        `If you want framework versions instead, delete the corresponding .claude/skills/<name>/ ` +
        `directory manually and re-run /init-vault.`,
    );
  }

  emit({
    status: 'ok',
    message:
      `Module "${module_name}" installed (v${version}). ` +
      `Skills: ${installed} fresh, ${updated} updated, ${upToDate} up-to-date, ${skipped.length} skipped.`,
    actions,
    warnings,
    next_steps,
    module_status: 'installed',
  });
}

try {
  main();
} catch (err) {
  fail(`Unhandled error: ${err.message}\n${err.stack}`);
}
