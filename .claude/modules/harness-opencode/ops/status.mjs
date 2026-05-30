#!/usr/bin/env node
// harness-opencode module — status handler.
//
// Mirror of harness-claude-code/status, with two differences:
//   - reads <vault>/opencode.json::mcp[<name>]
//   - additionally probes wrapper files under .opencode/commands/ for parity
//     with the install handler's bulk generation (count drift, content drift).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../../core/lib/config_patch.mjs';
import { buildRegistry } from '../../core/lib/mcp_registry.mjs';
import { readStdin } from '../../core/lib/read_input.mjs';
import {
  buildWrapperContent,
  scanVaultSkills,
} from '../../core/lib/opencode_wrappers.mjs';

const MODULE_NAME = 'harness-opencode';


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
  const e = {
    type: resolved.type || 'local',
    command: [resolved.command, ...(resolved.args || [])],
    enabled: true,
  };
  if (resolved.env && Object.keys(resolved.env).length > 0) {
    e.environment = resolved.env;
  }
  return e;
}

function probeWrappers(vault_root) {
  const skills = scanVaultSkills(vault_root);
  let synced = 0;
  let drift = 0;
  let missing = 0;
  const driftDetails = [];

  for (const sk of skills) {
    if (sk.skipped) continue;
    const wrapperPath = join(vault_root, '.opencode/commands', `${sk.name}.md`);
    const generated = buildWrapperContent(sk.name, sk.description);
    if (!existsSync(wrapperPath)) {
      missing++;
      driftDetails.push({ skill: sk.name, state: 'missing' });
      continue;
    }
    const current = readFileSync(wrapperPath, 'utf-8');
    if (current === generated) synced++;
    else {
      drift++;
      driftDetails.push({ skill: sk.name, state: 'drift' });
    }
  }
  return { synced, drift, missing, drift_details: driftDetails, total: skills.length };
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) {
    emit({ status: 'error', message: 'Empty stdin.', module_status: 'unknown' });
    process.exit(1);
  }

  const input = JSON.parse(raw);
  const { vault_root, module_dir, config = {} } = input;

  const configPath = config.config_path || join(vault_root, 'opencode.json');
  const manifestPath = join(vault_root, '.claude/vault-manifest.yaml');
  const modulesDir = join(vault_root, '.claude/modules');

  const cfg = readJson(configPath);
  const registeredServers = cfg.mcp || {};

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

  const wrappers = probeWrappers(vault_root);
  const wrappersOk = wrappers.missing === 0 && wrappers.drift === 0;
  if (!wrappersOk) {
    warnings.push({
      type: 'wrappers_out_of_sync',
      message: `${wrappers.missing} missing + ${wrappers.drift} drifted wrapper(s) under .opencode/commands/. Re-run install to sync.`,
    });
  }

  const components = {
    config_file_exists: existsSync(configPath),
    servers,
    wrappers,
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
  } else if (
    !components.claude_md_subblock ||
    (anyExpected && !allMatched) ||
    !wrappersOk
  ) {
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
