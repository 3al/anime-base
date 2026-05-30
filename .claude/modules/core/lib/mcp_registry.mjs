// MCP registry: read provides.mcp_server from each manifest module's module.yaml,
// resolve template vars, return registration entries ready for harness patching.
//
// YAML parsing strategy: targeted regex extraction of known fields under
// provides.mcp_server. Not a general YAML parser. Unknown keys are silently
// ignored. Supported field syntax:
//
//   name: scalar
//   command: scalar
//   type: scalar           (optional; harness applies harness-specific default)
//   args: ["x", "y"]       (flow-style JSON array)
//   args:                  (or block list)
//     - "x"
//     - "y"
//   env:                   (block map of scalars)
//     KEY1: value1
//     KEY2: "value2"
//
// Quoted scalars support both " and '. Multi-line scalars and anchors are
// out of scope (declare them differently if needed).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTemplate, buildVars } from './template_vars.mjs';

/**
 * Read and parse manifest, return list of module names in declaration order.
 * Mirrors logic in setup.mjs's listManifestModules.
 */
export function listManifestModules(manifestPath) {
  if (!existsSync(manifestPath)) return [];
  const lines = readFileSync(manifestPath, 'utf-8').split(/\r?\n/);
  const modules = [];
  let inModules = false;
  for (const line of lines) {
    if (/^modules:\s*$/.test(line)) {
      inModules = true;
      continue;
    }
    if (inModules) {
      const m = line.match(/^\s*-\s*(\S+)/);
      if (m) modules.push(m[1]);
      else if (/^\S/.test(line)) break;
    }
  }
  return modules;
}

/**
 * Read top-level install_scope from a module's module.yaml.
 * Per Shared_Install_Architecture.md §4 — opt-in shared layout marker.
 *
 * @returns 'shared' | 'per-vault' (default when field absent).
 */
export function readInstallScope(moduleDir) {
  const yamlPath = join(moduleDir, 'module.yaml');
  if (!existsSync(yamlPath)) return 'per-vault';
  const text = readFileSync(yamlPath, 'utf-8');
  // Top-level scalar: line starting at column 0, before any indented blocks.
  const m = text.match(/^install_scope:\s*(\S+)\s*$/m);
  if (!m) return 'per-vault';
  const val = stripQuotes(m[1]);
  return val === 'shared' ? 'shared' : 'per-vault';
}

/**
 * Read provides.mcp_server from a module's module.yaml.
 * @returns parsed spec object {name, command, args, env, type?} or null if not declared.
 */
export function readMcpServerSpec(moduleDir) {
  const yamlPath = join(moduleDir, 'module.yaml');
  if (!existsSync(yamlPath)) return null;
  const text = readFileSync(yamlPath, 'utf-8');

  const block = extractBlock(text, 'mcp_server');
  if (block === null) return null;
  const trimmed = block.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === '~') return null;

  const spec = {};

  const nameMatch = block.match(/^\s+name:\s*(.+?)\s*$/m);
  if (nameMatch) spec.name = stripQuotes(nameMatch[1]);

  const commandMatch = block.match(/^\s+command:\s*(.+?)\s*$/m);
  if (commandMatch) spec.command = stripQuotes(commandMatch[1]);

  const typeMatch = block.match(/^\s+type:\s*(.+?)\s*$/m);
  if (typeMatch) spec.type = stripQuotes(typeMatch[1]);

  // args: flow ["x", "y"] or block list
  const argsFlowMatch = block.match(/^\s+args:\s*(\[.*\])\s*$/m);
  if (argsFlowMatch) {
    spec.args = JSON.parse(argsFlowMatch[1]);
  } else {
    const argsBlock = extractBlock(block, 'args');
    spec.args = argsBlock ? parseBlockList(argsBlock) : [];
  }

  // env: block map
  const envBlock = extractBlock(block, 'env');
  spec.env = envBlock ? parseBlockMap(envBlock) : {};

  return spec;
}

/**
 * Build registration entries for all modules in the manifest.
 *
 * @returns array of { module, spec, install_scope, resolved, missing_binary, installed } where:
 *   - module: module name
 *   - spec: parsed mcp_server spec from module.yaml (raw, with template vars)
 *   - install_scope: 'shared' | 'per-vault' (read from module.yaml top level)
 *   - resolved: spec with template vars resolved (or null if no spec)
 *   - missing_binary: true if resolved.command points to a node binary path
 *     that doesn't exist on disk (warning-worthy but not fatal)
 *   - installed: true if module's per-vault marker (<module_dir>/.installed)
 *     exists. Phase 6.1 fix for D8 — harness must skip registration of modules
 *     whose install handler failed or was skipped. Per-vault marker is the
 *     single source of truth: install handlers write it on success, missing
 *     marker == module is not ready to register.
 */
export function buildRegistry(vault_root, modulesDir, manifestPath) {
  const modules = listManifestModules(manifestPath);
  const entries = [];
  for (const name of modules) {
    const moduleDir = join(modulesDir, name);
    const spec = readMcpServerSpec(moduleDir);
    if (!spec || !spec.name || !spec.command) continue;
    const install_scope = readInstallScope(moduleDir);
    const vars = buildVars(vault_root, name, { install_scope });
    const resolved = resolveTemplate(spec, vars);
    const missing_binary = detectMissingBinary(resolved);
    const installed = existsSync(join(moduleDir, '.installed'));
    entries.push({ module: name, spec, install_scope, resolved, missing_binary, installed });
  }
  return entries;
}

/**
 * Heuristic: if command is "node" and first arg looks like a path to a
 * .js file, check existence. For other commands (python in venv, etc.) we
 * don't currently introspect — a missing venv just means MCP fails to start
 * and Claude Code surfaces it in its UI.
 */
function detectMissingBinary(resolved) {
  if (resolved.command !== 'node') return false;
  const first = (resolved.args || [])[0];
  if (!first || typeof first !== 'string') return false;
  if (!first.endsWith('.js') && !first.endsWith('.mjs') && !first.endsWith('.cjs')) return false;
  return !existsSync(first);
}

/**
 * Find the body of a block under `key`. Returns the text under `key:` whose
 * indent exceeds the indent of the key's line. Returns null if key not found.
 * If `key:` has an inline scalar value, that scalar is returned as a string.
 */
function extractBlock(text, key) {
  const lines = text.split(/\r?\n/);
  const keyRe = new RegExp(`^(\\s*)${escapeRegex(key)}:\\s*(.*)$`);
  let startIdx = -1;
  let blockIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(keyRe);
    if (m) {
      const inlineValue = m[2].trim();
      if (inlineValue !== '' && !inlineValue.startsWith('#')) {
        return inlineValue; // inline scalar (e.g. `mcp_server: null`)
      }
      blockIndent = m[1].length;
      startIdx = i + 1;
      break;
    }
  }
  if (startIdx === -1) return null;

  const bodyLines = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      bodyLines.push(line);
      continue;
    }
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= blockIndent) break;
    bodyLines.push(line);
  }
  return bodyLines.join('\n');
}

function parseBlockList(block) {
  return block
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*-\s*(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => stripQuotes(m[1]));
}

function parseBlockMap(block) {
  const out = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*?):\s*(.+?)\s*$/);
    if (m) out[m[1]] = stripQuotes(m[2]);
  }
  return out;
}

function stripQuotes(s) {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
