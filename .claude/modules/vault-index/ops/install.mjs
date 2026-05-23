#!/usr/bin/env node
// vault-index module — install handler.
//
// Wraps the existing in-place MCP source at <vault>/.claude/mcp-server/.
// If dist/ is missing, runs `npm install && npm run build` once.
// Adds a sub-block in CLAUDE.md with a short module description.
//
// Contract: see SYSTEM/Vault_Bootstrap_Architecture.md → "Контракт операций".

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureSubBlock } from '../../core/lib/managed_block.mjs';

const LEGACY_SOURCE_REL = '.claude/mcp-server';
const CANONICAL_SOURCE_SUBDIR = 'mcp';
const SUB_BLOCK_TARGET = 'CLAUDE.md';
const MODULE_NAME = 'vault-index';

/**
 * Detect which MCP source layout is present.
 * Returns { mcpDir, layout, warnings, next_steps } where:
 *   - mcpDir: absolute path to use for source
 *   - layout: 'canonical' | 'legacy' | 'mixed' | 'missing'
 */
function detectLayout(vault_root, module_dir) {
  const legacy = join(vault_root, LEGACY_SOURCE_REL);
  const canonical = join(module_dir, CANONICAL_SOURCE_SUBDIR);
  const hasLegacy = existsSync(join(legacy, 'package.json')) && existsSync(join(legacy, 'src'));
  const hasCanonical =
    existsSync(join(canonical, 'package.json')) && existsSync(join(canonical, 'src'));

  if (hasCanonical && hasLegacy) {
    return {
      mcpDir: canonical,
      layout: 'mixed',
      warnings: [
        {
          type: 'duplicate_mcp_layout',
          message:
            'Detected MCP source in BOTH legacy (.claude/mcp-server/) and canonical (.claude/modules/vault-index/mcp/) locations. Using canonical. After verifying everything works, удалите legacy директорию вручную: `git rm -r .claude/mcp-server/`.',
        },
      ],
      next_steps: [
        'Verify MCP works (test через /mcp в Claude Code), затем `git rm -r .claude/mcp-server/` чтобы избавиться от дубликата.',
      ],
    };
  }
  if (hasCanonical) {
    return { mcpDir: canonical, layout: 'canonical', warnings: [], next_steps: [] };
  }
  if (hasLegacy) {
    return {
      mcpDir: legacy,
      layout: 'legacy',
      warnings: [
        {
          type: 'legacy_mcp_layout',
          message:
            'Используется legacy layout: MCP source в .claude/mcp-server/. Это работает, но не переносится при копировании portable bundle (source должен жить внутри модуля). Canonical layout: .claude/modules/vault-index/mcp/ + built-копия в .claude/mcp-servers/vault-index/.',
        },
      ],
      next_steps: [
        'Миграция на canonical layout — опциональна и безопасна (атомарная операция через будущий /migrate-vault-index скилл, который одновременно обновит регистрацию в ~/.claude.json и opencode.json). Запускать когда будете готовы переносить инфру на новый волт.',
      ],
    };
  }
  return { mcpDir: null, layout: 'missing', warnings: [], next_steps: [] };
}

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

function runNpm(args, cwd) {
  // shell:true → подхватывает npm.cmd на Windows из PATH.
  const result = spawnSync('npm', args, {
    cwd,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
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

  // 1. Detect MCP source layout (canonical / legacy / mixed / missing).
  const detection = detectLayout(vault_root, module_dir);
  if (detection.layout === 'missing') {
    fail(
      `MCP source not found in either canonical (.claude/modules/vault-index/mcp/) or legacy ` +
        `(.claude/mcp-server/) location. Copy MCP source into the canonical path or run ` +
        `/migrate-vault-index from a vault that has it.`,
      { module_status: 'missing_prerequisite' },
    );
  }
  const mcpDir = detection.mcpDir;
  warnings.push(...detection.warnings);
  next_steps.push(...detection.next_steps);
  actions.push({
    type: 'layout_detected',
    layout: detection.layout,
    target: mcpDir.replace(vault_root, '').replace(module_dir, '<module>'),
  });

  // 2. Build if dist/ missing.
  const distEntry = join(mcpDir, 'dist', 'index.js');
  if (!existsSync(distEntry)) {
    actions.push({ type: 'npm_install_start', target: mcpDir });
    const inst = runNpm(['install', '--no-audit', '--no-fund'], mcpDir);
    if (inst.code !== 0) {
      fail(`npm install failed (exit ${inst.code}): ${inst.stderr.slice(-500)}`, {
        actions, warnings, next_steps,
      });
    }
    actions.push({ type: 'npm_install_done', target: mcpDir });

    actions.push({ type: 'npm_build_start', target: mcpDir });
    const build = runNpm(['run', 'build'], mcpDir);
    if (build.code !== 0) {
      fail(`npm run build failed (exit ${build.code}): ${build.stderr.slice(-500)}`, {
        actions, warnings, next_steps,
      });
    }
    actions.push({ type: 'npm_build_done', target: mcpDir });

    if (!existsSync(distEntry)) {
      fail(`Build completed but dist/index.js still missing at ${distEntry}.`, {
        actions, warnings, next_steps,
      });
    }
  } else {
    actions.push({ type: 'verified', target: 'dist/index.js', detail: 'already built, skipping npm' });
  }

  // 3. Sub-block in CLAUDE.md.
  const claudeMdPath = join(vault_root, SUB_BLOCK_TARGET);
  if (!existsSync(claudeMdPath)) {
    fail(`${SUB_BLOCK_TARGET} not found — install \`core\` module first.`, {
      module_status: 'missing_prerequisite',
    });
  }
  const fragment = loadFragment(module_dir, 'claude-md.fragment');
  const sbResult = ensureSubBlock(claudeMdPath, MODULE_NAME, fragment);
  if (sbResult.changed) {
    actions.push({ type: 'sub_block', target: SUB_BLOCK_TARGET, action: sbResult.action });
  }

  // 4. Write .installed marker.
  const installedMarker = join(module_dir, '.installed');
  const version = readModuleVersion(module_dir);
  mkdirSync(dirname(installedMarker), { recursive: true });
  writeFileSync(
    installedMarker,
    JSON.stringify({ version, installed_at: new Date().toISOString() }, null, 2),
  );
  actions.push({ type: 'marker_written', target: '.installed', version });

  // Hint about manual MCP registration until harness-* modules exist.
  next_steps.push(
    'Регистрация в ~/.claude.json — пока вручную (см. SYSTEM/MCP_Server_Design.md → «Регистрация в Claude Code»). Автоматическая регистрация появится с harness-claude-code модулем.',
  );

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
