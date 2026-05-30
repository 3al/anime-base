#!/usr/bin/env node
// harness-opencode module — install handler.
//
// Mirror of harness-claude-code, with two harness-specific differences:
//
//   1. Config location & shape. Opencode reads <vault>/opencode.json (not
//      ~/.claude.json); MCP servers live under top-level `mcp[<name>]`
//      (Opencode is single-project per config, no project-scoping needed).
//      Entry format: { type: "local", command: [cmd, ...args], environment, enabled }
//      — command is an array (not separate command+args), environment (not env),
//      explicit type ("local" for stdio), enabled flag.
//
//   2. Bulk wrapper generation. In Opencode, slash-invocation of a skill
//      does a passive load (SKILL.md dumped to chat, no execution). We
//      generate thin imperative wrappers at .opencode/commands/<name>.md
//      from every <vault>/.claude/skills/<name>/SKILL.md. Idempotent via
//      content diff. Spec: docs/Vault_Bootstrap_Architecture.md § Slash UX.
//
// Shared with harness-claude-code via core/lib/{config_patch,mcp_registry,
// template_vars,opencode_wrappers,managed_block}.mjs. Reconcile is add/update
// only — removed modules are NOT cleaned from opencode.json automatically.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ensureSubBlock } from '../../core/lib/managed_block.mjs';
import { readJson, writeJsonWithBackup } from '../../core/lib/config_patch.mjs';
import { buildRegistry } from '../../core/lib/mcp_registry.mjs';
import { readStdin } from '../../core/lib/read_input.mjs';
import {
  buildWrapperContent,
  scanVaultSkills,
} from '../../core/lib/opencode_wrappers.mjs';

const SUB_BLOCK_TARGET = 'CLAUDE.md';
const MODULE_NAME = 'harness-opencode';


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

/**
 * Compose Opencode JSON entry from resolved spec.
 *   { type: "local", command: [cmd, ...args], environment?, enabled: true }
 * `environment` is omitted when env is empty (matches Opencode's "remote" entries
 * that don't carry env at all). `type` default is "local" for stdio servers.
 */
function composeEntry(resolved) {
  const entry = {
    type: resolved.type || 'local',
    command: [resolved.command, ...(resolved.args || [])],
    enabled: true,
  };
  if (resolved.env && Object.keys(resolved.env).length > 0) {
    entry.environment = resolved.env;
  }
  return entry;
}

/**
 * Generate/update wrapper files under <vault>/.opencode/commands/.
 * Returns counts and a list of skipped skills (frontmatter unparseable, etc).
 */
function syncWrappers(vault_root) {
  const skills = scanVaultSkills(vault_root);
  const commandsDir = join(vault_root, '.opencode/commands');
  mkdirSync(commandsDir, { recursive: true });

  const created = [];
  const updated = [];
  const unchanged = [];
  const skipped = [];

  for (const sk of skills) {
    if (sk.skipped) {
      skipped.push({ name: sk.name, reason: sk.skipped });
      continue;
    }
    const target = join(commandsDir, `${sk.name}.md`);
    const generated = buildWrapperContent(sk.name, sk.description);
    if (existsSync(target)) {
      const current = readFileSync(target, 'utf-8');
      if (current === generated) {
        unchanged.push(sk.name);
        continue;
      }
      writeFileSync(target, generated);
      updated.push(sk.name);
    } else {
      writeFileSync(target, generated);
      created.push(sk.name);
    }
  }
  return { created, updated, unchanged, skipped, total: skills.length };
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

  // 1. Resolve config path (default <vault>/opencode.json).
  const configPath = config.config_path || join(vault_root, 'opencode.json');
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

  // 3. Patch opencode.json::mcp — additive merge (preserve non-managed entries
  //    like `exa` that the user added manually).
  const current = readJson(configPath);
  const next = { ...current };
  if (!next.$schema) {
    next.$schema = 'https://opencode.ai/config.json';
  }
  const existingMcp = { ...(next.mcp || {}) };

  const registered = [];
  const skippedReg = [];
  for (const ent of registry) {
    // Same guards as harness-claude-code (D8 + binary check).
    if (!ent.installed) {
      warnings.push({
        type: 'module_not_installed',
        module: ent.module,
        message:
          `Skipping registration of "${ent.spec.name}" from module ${ent.module} — ` +
          `per-vault marker .installed not found. Module install handler did not ` +
          `complete (failed or skipped). Run /init-vault --module ${ent.module} after ` +
          `resolving the install issue, then re-run harness-opencode install.`,
      });
      next_steps.push(
        `${ent.module}: install handler did not complete. Server "${ent.spec.name}" not registered in opencode.json.`,
      );
      skippedReg.push(ent.spec.name);
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
      skippedReg.push(ent.spec.name);
      continue;
    }
    existingMcp[ent.spec.name] = composeEntry(ent.resolved);
    registered.push(ent.spec.name);
  }
  next.mcp = existingMcp;

  const patchResult = writeJsonWithBackup(configPath, next);
  if (patchResult.changed) {
    actions.push({
      type: 'config_patched',
      target: configPath,
      key: `mcp`,
      registered,
      backup: patchResult.backup_path,
    });
    if (registered.length > 0) {
      next_steps.push(
        `Перезапустите Opencode, чтобы подхватить обновлённые регистрации MCP-серверов: ${registered.join(', ')}.`,
      );
    }
  } else {
    actions.push({
      type: 'config_unchanged',
      target: configPath,
      key: `mcp`,
      registered,
      detail: 'all entries already match expected values — no patch needed',
    });
  }
  if (skippedReg.length > 0) {
    actions.push({ type: 'registrations_skipped', servers: skippedReg });
  }

  // 4. Bulk-sync wrappers under .opencode/commands/.
  const wrapperResult = syncWrappers(vault_root);
  actions.push({
    type: 'wrappers_synced',
    target: '.opencode/commands/',
    total: wrapperResult.total,
    created: wrapperResult.created.length,
    updated: wrapperResult.updated.length,
    unchanged: wrapperResult.unchanged.length,
    skipped: wrapperResult.skipped.length,
  });
  for (const sk of wrapperResult.skipped) {
    warnings.push({
      type: 'wrapper_skipped',
      skill: sk.name,
      reason: sk.reason,
      message: `Skill "${sk.name}" — wrapper not generated (${sk.reason}). Fix SKILL.md frontmatter to include it.`,
    });
  }
  if (wrapperResult.created.length + wrapperResult.updated.length > 0) {
    next_steps.push(
      `Slash-команды доступны в Opencode после рестарта: /${[
        ...wrapperResult.created,
        ...wrapperResult.updated,
      ].slice(0, 5).join(', /')}${wrapperResult.created.length + wrapperResult.updated.length > 5 ? ' и др.' : ''}.`,
    );
  }

  // 5. Sub-block in CLAUDE.md.
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

  // 6. Write .installed marker.
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
  const skipSummary = skippedReg.length > 0 ? ` Skipped: ${skippedReg.join(', ')}.` : '';
  const wrapSummary =
    ` Wrappers: ${wrapperResult.created.length} created, ${wrapperResult.updated.length} updated, ${wrapperResult.unchanged.length} unchanged${wrapperResult.skipped.length ? `, ${wrapperResult.skipped.length} skipped` : ''}.`;

  emit({
    status: 'ok',
    message: `Module "${module_name}" installed (v${version}). ${summary}${skipSummary}${wrapSummary}`,
    actions,
    warnings,
    next_steps,
    module_status: 'installed',
  });
}

try { main(); } catch (err) { fail(`Unhandled error: ${err.message}\n${err.stack}`); }
