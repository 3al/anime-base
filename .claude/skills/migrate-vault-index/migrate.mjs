#!/usr/bin/env node
// migrate-vault-index — атомарная миграция layout legacy → canonical.
//
// Reads JSON from stdin, performs the migration with rollback safety, emits
// JSON report to stdout.
//
// See .claude/skills/migrate-vault-index/SKILL.md for protocol.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const LEGACY_SOURCE_REL = '.claude/mcp-server';
const CANONICAL_SOURCE_REL = '.claude/modules/vault-index/mcp';

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
    actions: extra.actions || [],
    warnings: extra.warnings || [],
    next_steps: extra.next_steps || [],
    ...extra,
  });
  process.exit(1);
}

function runCmd(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    shell: true,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Run a module handler (install or status) and parse its JSON output.
 */
function runHandler(vault_root, moduleName, op, config = {}) {
  const moduleDir = join(vault_root, '.claude/modules', moduleName);
  const handlerPath = join(moduleDir, 'ops', `${op}.mjs`);
  if (!existsSync(handlerPath)) {
    return { ok: false, error: `Handler not found: ${handlerPath}` };
  }
  const input = JSON.stringify({
    vault_root,
    module_name: moduleName,
    module_dir: moduleDir,
    config,
    language: 'ru',
    harness: ['claude-code'],
    platform: process.platform,
  });
  const r = spawnSync('node', [handlerPath], {
    shell: true,
    encoding: 'utf-8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    return {
      ok: false,
      error: `Handler exited ${r.status}: ${r.stderr.slice(-500)}`,
      raw: r.stdout,
    };
  }
  try {
    return { ok: true, result: JSON.parse(r.stdout) };
  } catch (err) {
    return { ok: false, error: `Failed to parse handler JSON: ${err.message}`, raw: r.stdout };
  }
}

function detectLayout(vault_root) {
  const legacyDir = join(vault_root, LEGACY_SOURCE_REL);
  const canonicalDir = join(vault_root, CANONICAL_SOURCE_REL);
  const hasLegacy =
    existsSync(join(legacyDir, 'package.json')) && existsSync(join(legacyDir, 'src'));
  const hasCanonical =
    existsSync(join(canonicalDir, 'package.json')) && existsSync(join(canonicalDir, 'src'));
  if (hasCanonical && hasLegacy) return 'mixed';
  if (hasCanonical) return 'canonical';
  if (hasLegacy) return 'legacy';
  return 'missing';
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) fail('Empty stdin — migrate.mjs expects JSON input.');

  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    fail(`Invalid stdin JSON: ${err.message}`);
  }

  const vault_root = input.vault_root;
  const dryRun = !!input.dry_run;
  if (!vault_root) fail('Missing required field: vault_root.');

  const actions = [];
  const warnings = [];
  const next_steps = [];

  // === 1. Pre-flight checks ===
  const obsidianDir = join(vault_root, '.obsidian');
  if (!existsSync(obsidianDir)) {
    fail(`.obsidian/ not found — not an Obsidian vault. Path: ${obsidianDir}`);
  }

  const moduleYaml = join(vault_root, '.claude/modules/vault-index/module.yaml');
  if (!existsSync(moduleYaml)) {
    fail(
      `vault-index module wrapper not found at ${moduleYaml}. Migration assumes module exists; install vault-index module first.`,
    );
  }

  const gitDir = join(vault_root, '.git');
  if (!existsSync(gitDir)) {
    fail(
      `Vault is not a git repo (.git/ not found at ${gitDir}). Migration uses git mv — initialize git first or do migration manually.`,
    );
  }

  const layout = detectLayout(vault_root);
  actions.push({ type: 'preflight_layout_detected', layout });

  if (layout === 'canonical') {
    emit({
      status: 'ok',
      message: 'Already on canonical layout — nothing to migrate.',
      actions,
      warnings,
      next_steps,
      layout_before: 'canonical',
      layout_after: 'canonical',
      changed: false,
    });
    return;
  }
  if (layout === 'missing') {
    fail(
      'No vault-index source found in either legacy or canonical location. Cannot migrate from nothing — install vault-index first.',
      { actions },
    );
  }
  if (layout === 'mixed') {
    fail(
      'Both legacy AND canonical paths exist. Refusing to auto-resolve — manually pick which to keep, remove the other, then re-run migration.',
      {
        actions,
        next_steps: [
          'Inspect .claude/mcp-server/ vs .claude/modules/vault-index/mcp/ — выбрать актуальную версию.',
          'git rm -r на устаревшую директорию.',
          'Запустить /init-vault для синхронизации остального состояния.',
        ],
      },
    );
  }

  // From here on: layout === 'legacy'
  const legacyAbs = resolve(join(vault_root, LEGACY_SOURCE_REL));
  const canonicalAbs = resolve(join(vault_root, CANONICAL_SOURCE_REL));
  const configPath = join(homedir(), '.claude.json');

  if (dryRun) {
    emit({
      status: 'ok',
      message: 'Dry run — no changes made. Plan ready.',
      actions: [
        ...actions,
        { type: 'plan', step: 1, action: 'backup_config', target: configPath },
        { type: 'plan', step: 2, action: 'git_mv', from: legacyAbs, to: canonicalAbs },
        { type: 'plan', step: 3, action: 'npm_install_build_if_needed', target: canonicalAbs },
        { type: 'plan', step: 4, action: 'rerun_install', module: 'vault-index' },
        { type: 'plan', step: 5, action: 'rerun_install', module: 'harness-claude-code' },
        { type: 'plan', step: 6, action: 'verify_status', modules: ['vault-index', 'harness-claude-code'] },
      ],
      warnings,
      next_steps: [
        'Запустить migrate.mjs без --dry-run чтобы выполнить план.',
      ],
      layout_before: 'legacy',
      layout_after: 'legacy',
      changed: false,
    });
    return;
  }

  // === 2. Explicit pre-migrate backup of ~/.claude.json ===
  let preMigrateBackup = null;
  if (existsSync(configPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    preMigrateBackup = `${configPath}.bak.pre-migrate.${stamp}`;
    try {
      copyFileSync(configPath, preMigrateBackup);
      actions.push({ type: 'config_backed_up', target: configPath, backup: preMigrateBackup });
    } catch (err) {
      fail(`Failed to backup ${configPath}: ${err.message}`, { actions });
    }
  }

  // Track rollback state.
  let gitMoved = false;

  function rollback(reason) {
    const rollbackActions = [];
    if (gitMoved) {
      const r = runCmd('git', ['mv', '--', canonicalAbs, legacyAbs], vault_root);
      if (r.code === 0) {
        rollbackActions.push({ type: 'rollback_git_mv', ok: true });
      } else {
        rollbackActions.push({
          type: 'rollback_git_mv',
          ok: false,
          stderr: r.stderr.slice(-500),
        });
      }
    }
    if (preMigrateBackup && existsSync(preMigrateBackup)) {
      try {
        copyFileSync(preMigrateBackup, configPath);
        rollbackActions.push({ type: 'rollback_config_restore', ok: true });
      } catch (err) {
        rollbackActions.push({ type: 'rollback_config_restore', ok: false, error: err.message });
      }
    }
    return rollbackActions;
  }

  // === 3. git mv ===
  const mv = runCmd('git', ['mv', '--', legacyAbs, canonicalAbs], vault_root);
  if (mv.code !== 0) {
    fail(`git mv failed (exit ${mv.code}): ${mv.stderr.slice(-500)}`, {
      actions, warnings, next_steps,
    });
  }
  gitMoved = true;
  actions.push({ type: 'git_mv', from: legacyAbs, to: canonicalAbs });

  // === 4. Build if dist/ missing in canonical location ===
  const distEntry = join(canonicalAbs, 'dist', 'index.js');
  if (!existsSync(distEntry)) {
    const inst = runCmd('npm', ['install', '--no-audit', '--no-fund'], canonicalAbs);
    if (inst.code !== 0) {
      const rb = rollback('npm install failed');
      fail(`npm install failed (exit ${inst.code}): ${inst.stderr.slice(-500)}`, {
        actions: [...actions, { type: 'npm_install_failed' }, ...rb],
        warnings, next_steps: ['Inspect npm error output and resolve manually.'],
      });
    }
    actions.push({ type: 'npm_install_done', target: canonicalAbs });

    const build = runCmd('npm', ['run', 'build'], canonicalAbs);
    if (build.code !== 0) {
      const rb = rollback('npm run build failed');
      fail(`npm run build failed (exit ${build.code}): ${build.stderr.slice(-500)}`, {
        actions: [...actions, { type: 'npm_build_failed' }, ...rb],
        warnings, next_steps: ['Inspect build error output and resolve manually.'],
      });
    }
    actions.push({ type: 'npm_build_done', target: canonicalAbs });

    if (!existsSync(distEntry)) {
      const rb = rollback('build did not produce dist/index.js');
      fail(`Build completed but dist/index.js missing at ${distEntry}.`, {
        actions: [...actions, ...rb],
        warnings, next_steps,
      });
    }
  } else {
    actions.push({ type: 'verified', target: 'dist/index.js', detail: 'moved with git mv, already built' });
  }

  // === 5. Re-install vault-index (will detect canonical now) ===
  const viResult = runHandler(vault_root, 'vault-index', 'install');
  if (!viResult.ok || viResult.result.status !== 'ok') {
    const rb = rollback('vault-index install failed');
    fail(
      `vault-index install handler failed: ${viResult.error || viResult.result?.message}`,
      {
        actions: [...actions, { type: 'vault_index_install_failed' }, ...rb],
        warnings, next_steps,
      },
    );
  }
  actions.push({ type: 'vault_index_reinstalled' });

  // === 6. Re-install harness-claude-code (will detect new binary path, patch config) ===
  const hcResult = runHandler(vault_root, 'harness-claude-code', 'install');
  if (!hcResult.ok || hcResult.result.status !== 'ok') {
    const rb = rollback('harness-claude-code install failed');
    fail(
      `harness-claude-code install handler failed: ${hcResult.error || hcResult.result?.message}`,
      {
        actions: [...actions, { type: 'harness_install_failed' }, ...rb],
        warnings, next_steps,
      },
    );
  }
  actions.push({ type: 'harness_claude_code_reinstalled' });
  // Carry through harness-claude-code's own next_steps (e.g. "restart Claude Code").
  if (hcResult.result.next_steps) next_steps.push(...hcResult.result.next_steps);

  // === 7. Verification ===
  const viStatus = runHandler(vault_root, 'vault-index', 'status');
  const hcStatus = runHandler(vault_root, 'harness-claude-code', 'status');
  if (!viStatus.ok || viStatus.result.module_status !== 'installed') {
    warnings.push({
      type: 'post_migrate_status_anomaly',
      message: `vault-index status after migration: ${viStatus.result?.module_status || 'unknown'}. Inspect manually.`,
    });
  } else if (viStatus.result.components.layout !== 'canonical') {
    warnings.push({
      type: 'post_migrate_layout_anomaly',
      message: `vault-index reports layout=${viStatus.result.components.layout} after migration; expected canonical.`,
    });
  }
  if (!hcStatus.ok || hcStatus.result.module_status !== 'installed') {
    warnings.push({
      type: 'post_migrate_status_anomaly',
      message: `harness-claude-code status after migration: ${hcStatus.result?.module_status || 'unknown'}. Inspect manually.`,
    });
  }
  actions.push({
    type: 'verified',
    detail: 'post-migration status checks',
    vault_index_status: viStatus.result?.module_status,
    vault_index_layout: viStatus.result?.components?.layout,
    harness_status: hcStatus.result?.module_status,
  });

  next_steps.push(
    `Pre-migrate backup сохранён: ${preMigrateBackup}. Можно удалить вручную после проверки что всё работает.`,
  );
  next_steps.push(
    'Закоммить миграцию: `git add .claude/modules/vault-index/mcp .claude/mcp-server` (последнее покажет deletion после git mv) + commit.',
  );

  emit({
    status: 'ok',
    message: 'Migration legacy → canonical completed successfully.',
    actions,
    warnings,
    next_steps,
    layout_before: 'legacy',
    layout_after: 'canonical',
    changed: true,
    pre_migrate_backup: preMigrateBackup,
  });
}

try {
  main();
} catch (err) {
  fail(`Unhandled error: ${err.message}\n${err.stack}`);
}
