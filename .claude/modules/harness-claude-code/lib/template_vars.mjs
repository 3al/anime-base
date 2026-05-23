// Template variable resolver for module.yaml provides.mcp_server entries.
//
// Contract (Vault_Bootstrap_Architecture.md §«module.yaml» +
// Shared_Install_Architecture.md §5):
//   {vault_root}         — abs path of vault root (always per-vault)
//   {module_dir}         — <vault_root>/.claude/modules/<name>/  (per-vault state dir)
//   {module_bin}         — venv binary dir, branches on install_scope:
//                            per-vault → {module_dir}/mcp/.venv/{Scripts|bin}
//                            shared    → {shared_module_dir}/.venv/{Scripts|bin}
//   {module_dist}        — dist dir, branches on install_scope:
//                            per-vault → {module_dir}/mcp/dist/
//                            shared    → {shared_module_dir}/mcp/dist/
//   {shared_module_dir}  — $VAULT_TOOLS_HOME/<name>/  (shared scope only;
//                          empty string for per-vault to make stray refs visible)
//
// All paths use forward slashes regardless of OS — matches Claude Code's
// project-key convention and avoids Windows backslash escaping in JSON.

import { resolve } from 'node:path';
import { platform } from 'node:os';
import { resolveSharedToolsHome } from '../../core/lib/paths.mjs';

// Re-export for callers that already grab it from template_vars (back-compat).
export { resolveSharedToolsHome };

const TOKEN_RE = /\{(vault_root|module_dir|module_bin|module_dist|shared_module_dir)\}/g;

/**
 * Build template variables for a module's MCP-server registration.
 *
 * @param {string} vault_root — abs path of the vault.
 * @param {string} module_name — module identifier (kebab-case).
 * @param {object} [opts]
 * @param {'per-vault'|'shared'} [opts.install_scope='per-vault']
 *        Selects layout for {module_bin}/{module_dist} resolution.
 * @returns {{vault_root: string, module_dir: string, module_bin: string, module_dist: string, shared_module_dir: string}}
 */
export function buildVars(vault_root, module_name, opts = {}) {
  const install_scope = opts.install_scope || 'per-vault';
  const vr = resolve(vault_root).replace(/\\/g, '/');
  const md = `${vr}/.claude/modules/${module_name}`;
  const venvSubdir = platform() === 'win32' ? 'Scripts' : 'bin';

  let smd = '';
  let module_bin;
  let module_dist;

  if (install_scope === 'shared') {
    const sharedRoot = resolveSharedToolsHome();
    smd = `${sharedRoot}/${module_name}`;
    module_bin = `${smd}/.venv/${venvSubdir}`;
    module_dist = `${smd}/mcp/dist`;
  } else {
    // per-vault (default)
    module_bin = `${md}/mcp/.venv/${venvSubdir}`;
    module_dist = `${md}/mcp/dist`;
  }

  return {
    vault_root: vr,
    module_dir: md,
    module_bin,
    module_dist,
    shared_module_dir: smd,
  };
}

export function resolveTemplate(value, vars) {
  if (typeof value === 'string') {
    return value.replace(TOKEN_RE, (_, key) => vars[key]);
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveTemplate(v, vars));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveTemplate(v, vars);
    return out;
  }
  return value;
}
