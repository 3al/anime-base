#!/usr/bin/env node
// vault-index module — status handler.
//
// Read-only inspection. Reports module_status based on:
//   - .installed marker (presence + version)
//   - MCP source files present (legacy and/or canonical layout)
//   - dist/index.js (built artifact)
//   - sub-block in CLAUDE.md
//
// Also reports detected layout so /init-vault --check can show the user
// whether they're on legacy or canonical layout, and surface migration hints.
//
// Contract: see SYSTEM/Vault_Bootstrap_Architecture.md → "Контракт операций".

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin } from '../../core/lib/read_input.mjs';

const LEGACY_SOURCE_REL = '.claude/mcp-server';
const CANONICAL_SOURCE_SUBDIR = 'mcp';
const MODULE_NAME = 'vault-index';


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

function hasSubBlock(filePath, moduleName) {
  if (!existsSync(filePath)) return false;
  const body = readFileSync(filePath, 'utf-8');
  return (
    body.includes(`<!-- BEGIN: module:${moduleName} -->`) &&
    body.includes(`<!-- END: module:${moduleName} -->`)
  );
}

function detectLayout(vault_root, module_dir) {
  const legacy = join(vault_root, LEGACY_SOURCE_REL);
  const canonical = join(module_dir, CANONICAL_SOURCE_SUBDIR);
  const hasLegacy = existsSync(join(legacy, 'package.json')) && existsSync(join(legacy, 'src'));
  const hasCanonical =
    existsSync(join(canonical, 'package.json')) && existsSync(join(canonical, 'src'));
  if (hasCanonical && hasLegacy) return { layout: 'mixed', activeDir: canonical };
  if (hasCanonical) return { layout: 'canonical', activeDir: canonical };
  if (hasLegacy) return { layout: 'legacy', activeDir: legacy };
  return { layout: 'missing', activeDir: null };
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) {
    emit({ status: 'error', message: 'Empty stdin.', module_status: 'unknown' });
    process.exit(1);
  }

  const input = JSON.parse(raw);
  const { vault_root, module_dir } = input;

  const { layout, activeDir } = detectLayout(vault_root, module_dir);
  const distBuilt = activeDir ? existsSync(join(activeDir, 'dist', 'index.js')) : false;

  const components = {
    mcp_source: layout !== 'missing',
    layout,
    dist_built: distBuilt,
    installed_marker: existsSync(join(module_dir, '.installed')),
    claude_md_subblock: hasSubBlock(join(vault_root, 'CLAUDE.md'), MODULE_NAME),
  };

  const warnings = [];
  if (layout === 'legacy') {
    warnings.push({
      type: 'legacy_mcp_layout',
      message:
        'MCP source в legacy-локации .claude/mcp-server/. Работает, но не переносится при копировании portable bundle. Миграция — через /migrate-vault-index (когда модуль готов).',
    });
  } else if (layout === 'mixed') {
    warnings.push({
      type: 'duplicate_mcp_layout',
      message:
        'MCP source присутствует в обоих локациях (canonical + legacy). Используется canonical. Удалите legacy после проверки: `git rm -r .claude/mcp-server/`.',
    });
  }

  const version_available = readModuleVersion(module_dir);
  const version_installed = readInstalledVersion(module_dir);

  let module_status;
  if (!components.mcp_source) {
    module_status = 'missing_prerequisite';
  } else if (!components.installed_marker) {
    module_status = 'missing';
  } else if (version_installed !== version_available) {
    module_status = 'outdated';
  } else if (!components.dist_built || !components.claude_md_subblock) {
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
    warnings,
  });
}

try {
  main();
} catch (err) {
  emit({ status: 'error', message: err.message, module_status: 'unknown' });
  process.exit(1);
}
