#!/usr/bin/env node
// core module — install handler.
//
// What it does:
//   1. Verifies .obsidian/ marker (vault sanity).
//   2. Manages a managed-block in CLAUDE.md (creates outer wrapper for sub-blocks).
//   3. Manages a managed-block in .gitignore (state markers, MCP build artifacts).
//   4. Ensures SYSTEM/ directory and seeds governance templates (skip-if-exists).
//   5. Writes .installed state marker.
//
// Contract: see SYSTEM/Vault_Bootstrap_Architecture.md → "Контракт операций".

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ensureManagedBlock } from '../lib/managed_block.mjs';
import { readStdin } from '../lib/read_input.mjs';


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

  // 1. Verify .obsidian/
  const obsidianDir = join(vault_root, '.obsidian');
  if (!existsSync(obsidianDir)) {
    fail(
      `.obsidian/ not found at ${obsidianDir}. Open the vault in Obsidian once to initialize it.`,
      { module_status: 'missing_prerequisite' },
    );
  }
  actions.push({ type: 'verified', target: '.obsidian/', detail: 'Obsidian vault marker present' });

  // 2. CLAUDE.md managed-block
  const claudeMdPath = join(vault_root, 'CLAUDE.md');
  const claudeFragment = loadFragment(module_dir, 'claude-md.fragment');
  const claudeResult = ensureManagedBlock(claudeMdPath, claudeFragment, 'html');
  if (claudeResult.changed) {
    actions.push({ type: 'managed_block', target: 'CLAUDE.md', action: claudeResult.action });
  }

  // 3. .gitignore managed-block
  const gitignorePath = join(vault_root, '.gitignore');
  const gitignoreFragment = loadFragment(module_dir, 'gitignore.fragment');
  const giResult = ensureManagedBlock(gitignorePath, gitignoreFragment, 'hash');
  if (giResult.changed) {
    actions.push({ type: 'managed_block', target: '.gitignore', action: giResult.action });
  }

  // 4. SYSTEM/ governance templates (skip-if-exists; once seeded, the file is the user's).
  const templatesSystemDir = join(module_dir, 'templates', 'SYSTEM');
  if (existsSync(templatesSystemDir)) {
    const targetSystemDir = join(vault_root, 'SYSTEM');
    if (!existsSync(targetSystemDir)) {
      mkdirSync(targetSystemDir, { recursive: true });
      actions.push({ type: 'directory_created', target: 'SYSTEM/' });
    }
    const templates = readdirSync(templatesSystemDir).filter((name) =>
      name.endsWith('.md') && statSync(join(templatesSystemDir, name)).isFile(),
    );
    let seeded = 0;
    let kept = 0;
    for (const file of templates) {
      const target = join(targetSystemDir, file);
      if (existsSync(target)) {
        kept += 1;
        continue;
      }
      copyFileSync(join(templatesSystemDir, file), target);
      actions.push({ type: 'template_seeded', target: `SYSTEM/${file}` });
      seeded += 1;
    }
    if (kept > 0) {
      next_steps.push(
        `SYSTEM/: ${kept} существующих governance-шаблонов оставлены без изменений (skip-if-exists). ` +
          `Чтобы получить актуальную версию шаблона из core — удалите файл и перезапустите /init-vault.`,
      );
    }
  }

  // 5. Write .installed marker
  const installedMarker = join(module_dir, '.installed');
  const version = readModuleVersion(module_dir);
  const markerData = { version, installed_at: new Date().toISOString() };
  mkdirSync(dirname(installedMarker), { recursive: true });
  writeFileSync(installedMarker, JSON.stringify(markerData, null, 2));
  actions.push({ type: 'marker_written', target: '.installed', version });

  emit({
    status: 'ok',
    message: `Module "${module_name}" installed (v${version}).`,
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
