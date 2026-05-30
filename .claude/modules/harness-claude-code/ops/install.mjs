#!/usr/bin/env node
// harness-claude-code module — install handler.
//
// Generic registration of MCP servers in ~/.claude.json under PROJECT-SCOPED key:
//   projects[<vault_root_with_forward_slashes>].mcpServers[<server_name>]
//
// v0.2.0: iterates every module in the manifest, reads its provides.mcp_server
// from module.yaml, resolves template vars, patches config. v0.1.0 hardcoded
// only vault-index — kept as backwards reference in git history.
//
// Reconcile semantics: add/update only. If a module is removed from the
// manifest, its registration in ~/.claude.json is NOT removed automatically
// — manual cleanup. This is safer (avoids touching foreign entries) and
// simpler for v0.2.0; reconcile-with-delete is deferred.
//
// Contract: see SYSTEM/Vault_Bootstrap_Architecture.md → "Контракт операций".

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { ensureSubBlock } from '../../core/lib/managed_block.mjs';
import { readJson, writeJsonWithBackup } from '../../core/lib/config_patch.mjs';
import { buildRegistry } from '../../core/lib/mcp_registry.mjs';
import { readStdin } from '../../core/lib/read_input.mjs';

const SUB_BLOCK_TARGET = 'CLAUDE.md';
const MODULE_NAME = 'harness-claude-code';
const DEFAULT_TYPE = 'stdio';


function emit(result) {
  process.stdout.write(JSON.stringify(result, null, 2));
}

function fail(message, extra = {}) {
  emit({ status: 'error', message, actions: [], warnings: [], next_steps: [], ...extra });
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

function projectKey(vault_root) {
  return resolve(vault_root).replace(/\\/g, '/');
}

/**
 * Compose the JSON registration entry from a resolved mcp_server spec.
 * Claude Code-specific defaults (type=stdio) are applied here, not in the
 * shared registry, since other harnesses may use different conventions.
 */
function composeEntry(resolved) {
  const entry = {
    type: resolved.type || DEFAULT_TYPE,
    command: resolved.command,
    args: resolved.args || [],
  };
  if (resolved.env && Object.keys(resolved.env).length > 0) {
    entry.env = resolved.env;
  }
  return entry;
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) fail('Empty stdin — install handler expects JSON input.');

  let input;
  try { input = JSON.parse(raw); } catch (err) { fail(`Invalid stdin JSON: ${err.message}`); }

  const { vault_root, module_name, module_dir, config = {} } = input;
  if (!vault_root || !module_dir) {
    fail('Missing required input fields: vault_root, module_dir.');
  }

  const actions = [];
  const warnings = [];
  const next_steps = [];

  // 1. Resolve config path.
  const configPath = config.config_path || join(homedir(), '.claude.json');
  actions.push({ type: 'config_resolved', target: configPath });

  // 2. Build registry from manifest.
  const manifestPath = join(vault_root, '.claude/vault-manifest.yaml');
  const modulesDir = join(vault_root, '.claude/modules');
  if (!existsSync(manifestPath)) {
    fail(
      `Manifest not found at ${manifestPath}. /init-vault should create it before installing harness.`,
      { module_status: 'missing_prerequisite' },
    );
  }
  const registry = buildRegistry(vault_root, modulesDir, manifestPath);

  // 3. Compose patch under projects[<key>].mcpServers — additive merge.
  const projKey = projectKey(vault_root);
  const current = readJson(configPath);
  const next = { ...current };
  next.projects = { ...(next.projects || {}) };
  const existingProject = next.projects[projKey] || {};
  const existingServers = { ...(existingProject.mcpServers || {}) };

  const registered = [];
  const skipped = [];
  for (const ent of registry) {
    // Phase 6.1 fix (D8): skip registration of modules whose install handler
    // didn't write .installed marker (failed / skipped / not yet run). Without
    // this guard, harness would advertise a "connected" MCP server in CC that
    // either fails at startup (broken venv, missing dist/) or returns
    // INDEX_NOT_INITIALIZED on every tool call.
    if (!ent.installed) {
      warnings.push({
        type: 'module_not_installed',
        module: ent.module,
        message:
          `Skipping registration of "${ent.spec.name}" from module ${ent.module} — ` +
          `per-vault marker .installed not found. Module install handler did not ` +
          `complete (failed or skipped). Run /init-vault --module ${ent.module} after ` +
          `resolving the install issue, then re-run harness-claude-code install.`,
      });
      next_steps.push(
        `${ent.module}: install handler did not complete. Server "${ent.spec.name}" not registered.`,
      );
      skipped.push(ent.spec.name);
      continue;
    }
    if (ent.missing_binary) {
      warnings.push({
        type: 'binary_missing',
        module: ent.module,
        message:
          `Skipping registration of "${ent.spec.name}" from module ${ent.module} — ` +
          `binary not found at ${ent.resolved.args[0]}. ` +
          `Run install of ${ent.module} module first (it builds dist/), or — for vault-index in legacy layout — run /migrate-vault-index.`,
      });
      next_steps.push(
        `${ent.module}: build/migrate before re-running harness install. Skipped server: "${ent.spec.name}".`,
      );
      skipped.push(ent.spec.name);
      continue;
    }
    existingServers[ent.spec.name] = composeEntry(ent.resolved);
    registered.push(ent.spec.name);
  }

  next.projects[projKey] = { ...existingProject, mcpServers: existingServers };

  const patchResult = writeJsonWithBackup(configPath, next);
  if (patchResult.changed) {
    actions.push({
      type: 'config_patched',
      target: configPath,
      key: `projects["${projKey}"].mcpServers`,
      registered,
      backup: patchResult.backup_path,
    });
    if (registered.length > 0) {
      next_steps.push(
        `Перезапустите Claude Code, чтобы подхватить обновлённые регистрации MCP-серверов: ${registered.join(', ')}. Проверка: команда /mcp.`,
      );
    }
  } else {
    actions.push({
      type: 'config_unchanged',
      target: configPath,
      key: `projects["${projKey}"].mcpServers`,
      registered,
      detail: 'all entries already match expected values — no patch needed',
    });
  }
  if (skipped.length > 0) {
    actions.push({ type: 'registrations_skipped', servers: skipped });
  }

  // 4. Sub-block in CLAUDE.md.
  const claudeMdPath = join(vault_root, SUB_BLOCK_TARGET);
  if (!existsSync(claudeMdPath)) {
    fail(`${SUB_BLOCK_TARGET} not found — install \`core\` module first.`, {
      module_status: 'missing_prerequisite',
      actions, warnings, next_steps,
    });
  }
  const fragment = loadFragment(module_dir, 'claude-md.fragment');
  const sbResult = ensureSubBlock(claudeMdPath, MODULE_NAME, fragment);
  if (sbResult.changed) {
    actions.push({ type: 'sub_block', target: SUB_BLOCK_TARGET, action: sbResult.action });
  }

  // 5. Write .installed marker.
  const installedMarker = join(module_dir, '.installed');
  const version = readModuleVersion(module_dir);
  mkdirSync(dirname(installedMarker), { recursive: true });
  writeFileSync(
    installedMarker,
    JSON.stringify({ version, installed_at: new Date().toISOString() }, null, 2),
  );
  actions.push({ type: 'marker_written', target: '.installed', version });

  const summary = registered.length > 0
    ? `Registered: ${registered.join(', ')}`
    : 'No MCP servers registered (no manifest modules with provides.mcp_server, or all skipped).';
  const skipSummary = skipped.length > 0 ? ` Skipped: ${skipped.join(', ')}.` : '';

  emit({
    status: 'ok',
    message: `Module "${module_name}" installed (v${version}). ${summary}${skipSummary}`,
    actions,
    warnings,
    next_steps,
    module_status: 'installed',
  });
}

try { main(); } catch (err) { fail(`Unhandled error: ${err.message}\n${err.stack}`); }
