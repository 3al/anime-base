#!/usr/bin/env node
// harness-claude-code module — status handler.
//
// Generic: walks the manifest, builds expected registry, compares to
// projects[<vault_key>].mcpServers in ~/.claude.json, reports per-server
// state. v0.2.0 (was vault-index-only in v0.1.0).
//
// Contract: see SYSTEM/Vault_Bootstrap_Architecture.md → "Контракт операций".

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readJson } from '../lib/config_patch.mjs';
import { buildRegistry } from '../lib/mcp_registry.mjs';

const MODULE_NAME = 'harness-claude-code';
const DEFAULT_TYPE = 'stdio';

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

function readInstalledVersion(moduleDir) {
  const p = join(moduleDir, '.installed');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')).version; } catch { return null; }
}

function hasSubBlock(filePath, moduleName) {
  if (!existsSync(filePath)) return false;
  const body = readFileSync(filePath, 'utf-8');
  return (
    body.includes(`<!-- BEGIN: module:${moduleName} -->`) &&
    body.includes(`<!-- END: module:${moduleName} -->`)
  );
}

function projectKey(vault_root) {
  return resolve(vault_root).replace(/\\/g, '/');
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

function expectedEntry(resolved) {
  const e = { type: resolved.type || DEFAULT_TYPE, command: resolved.command, args: resolved.args || [] };
  if (resolved.env && Object.keys(resolved.env).length > 0) e.env = resolved.env;
  return e;
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) {
    emit({ status: 'error', message: 'Empty stdin.', module_status: 'unknown' });
    process.exit(1);
  }

  const input = JSON.parse(raw);
  const { vault_root, module_dir, config = {} } = input;

  const configPath = config.config_path || join(homedir(), '.claude.json');
  const projKey = projectKey(vault_root);
  const manifestPath = join(vault_root, '.claude/vault-manifest.yaml');
  const modulesDir = join(vault_root, '.claude/modules');

  const cfg = readJson(configPath);
  const projectEntry = (cfg.projects && cfg.projects[projKey]) || {};
  const registeredServers = projectEntry.mcpServers || {};

  const registry = existsSync(manifestPath)
    ? buildRegistry(vault_root, modulesDir, manifestPath)
    : [];

  const servers = [];
  const warnings = [];
  let allMatched = true;
  let anyExpected = false;

  for (const ent of registry) {
    anyExpected = true;
    const expected = expectedEntry(ent.resolved);
    const registered = registeredServers[ent.spec.name];
    let state;
    if (ent.missing_binary) {
      state = 'binary_missing';
      allMatched = false;
      warnings.push({
        type: 'binary_missing',
        module: ent.module,
        server: ent.spec.name,
        message: `Binary not found at ${ent.resolved.args[0]} — server cannot start. Build/migrate ${ent.module} module.`,
      });
    } else if (!registered) {
      state = 'not_registered';
      allMatched = false;
    } else if (!deepEqual(registered, expected)) {
      state = 'mismatch';
      allMatched = false;
      warnings.push({
        type: 'registration_mismatch',
        module: ent.module,
        server: ent.spec.name,
        message: `Registered config in ${configPath} differs from expected. Re-run install to sync.`,
      });
    } else {
      state = 'ok';
    }
    servers.push({
      module: ent.module,
      server: ent.spec.name,
      state,
      expected_binary: ent.resolved.args[0] || null,
      registered: !!registered,
    });
  }

  const components = {
    config_file_exists: existsSync(configPath),
    project_key: projKey,
    servers,
    installed_marker: existsSync(join(module_dir, '.installed')),
    claude_md_subblock: hasSubBlock(join(vault_root, 'CLAUDE.md'), MODULE_NAME),
  };

  const version_available = readModuleVersion(module_dir);
  const version_installed = readInstalledVersion(module_dir);

  let module_status;
  if (!components.installed_marker) {
    module_status = 'missing';
  } else if (version_installed !== version_available) {
    module_status = 'outdated';
  } else if (!components.claude_md_subblock || (anyExpected && !allMatched)) {
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

try { main(); } catch (err) {
  emit({ status: 'error', message: err.message, module_status: 'unknown' });
  process.exit(1);
}
