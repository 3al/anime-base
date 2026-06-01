#!/usr/bin/env node
// core module — status handler.
//
// Read-only inspection of the module's installed state and managed artifacts.
// Contract: see SYSTEM/Vault_Bootstrap_Architecture.md → "Контракт операций".

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hasOuterBlock } from '../lib/managed_block.mjs';
import { readStdin } from '../lib/read_input.mjs';
import { VISION_PROBE_REL } from '../lib/vision_probe.mjs';


function emit(result) {
  process.stdout.write(JSON.stringify(result, null, 2));
}

function readModuleVersion(moduleDir) {
  const path = join(moduleDir, 'module.yaml');
  if (!existsSync(path)) return 'unknown';
  const match = readFileSync(path, 'utf-8').match(/^version:\s*(.+)$/m);
  return match ? match[1].trim() : 'unknown';
}

function readInstalledVersion(moduleDir) {
  const path = join(moduleDir, '.installed');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')).version;
  } catch {
    return null;
  }
}

function collectSystemTemplates(vaultRoot, moduleDir) {
  const templatesDir = join(moduleDir, 'templates', 'SYSTEM');
  if (!existsSync(templatesDir)) return { expected: 0, present: 0, missing: [] };
  const expected = readdirSync(templatesDir).filter(
    (name) => name.endsWith('.md') && statSync(join(templatesDir, name)).isFile(),
  );
  const targetDir = join(vaultRoot, 'SYSTEM');
  const missing = [];
  let present = 0;
  for (const name of expected) {
    if (existsSync(join(targetDir, name))) {
      present += 1;
    } else {
      missing.push(name);
    }
  }
  return { expected: expected.length, present, missing };
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) {
    emit({ status: 'error', message: 'Empty stdin.', module_status: 'unknown' });
    process.exit(1);
  }

  const input = JSON.parse(raw);
  const { vault_root, module_dir } = input;

  const components = {
    obsidian_dir: existsSync(join(vault_root, '.obsidian')),
    installed_marker: existsSync(join(module_dir, '.installed')),
    claude_md_block: hasOuterBlock(join(vault_root, 'CLAUDE.md'), 'html'),
    gitignore_block: hasOuterBlock(join(vault_root, '.gitignore'), 'hash'),
    system_templates: collectSystemTemplates(vault_root, module_dir),
    vision_probe: existsSync(join(vault_root, VISION_PROBE_REL)),
  };

  const version_available = readModuleVersion(module_dir);
  const version_installed = readInstalledVersion(module_dir);

  let module_status;
  if (!components.obsidian_dir) {
    module_status = 'missing_prerequisite';
  } else if (!components.installed_marker) {
    module_status = 'missing';
  } else if (version_installed !== version_available) {
    module_status = 'outdated';
  } else if (!components.claude_md_block || !components.gitignore_block || !components.vision_probe) {
    // Marker says installed but a managed artifact is gone (block or vision
    // probe) — partial state, reinstall regenerates it.
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
