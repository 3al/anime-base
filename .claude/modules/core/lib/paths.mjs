// Shared path resolvers used across the bootstrap framework.
//
// Canonical source for $VAULT_TOOLS_HOME resolution. Imported by:
//   - core/lib/template_vars.mjs (MCP env vars)
//   - core/lib/shared_install.mjs (provisioning)
//
// No harness-specific assumptions — pure platform logic.

import { resolve } from 'node:path';
import { platform, homedir } from 'node:os';

/**
 * Resolve the platform-appropriate shared tools home for the current user.
 *
 * Priority (per Shared_Install_Architecture.md §3):
 *   1. $VAULT_TOOLS_HOME if set → absolute path.
 *   2. Windows  → %LOCALAPPDATA%\vault-tools\
 *   3. macOS    → $HOME/Library/Application Support/vault-tools/
 *   4. Linux    → ${XDG_DATA_HOME:-$HOME/.local/share}/vault-tools/
 *
 * Returns a forward-slash absolute path. Does NOT create the directory.
 */
export function resolveSharedToolsHome() {
  const override = process.env.VAULT_TOOLS_HOME;
  if (override && override.trim()) {
    return resolve(override.trim()).replace(/\\/g, '/');
  }

  const plat = platform();
  let root;
  if (plat === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      // Pathological case: %LOCALAPPDATA% unset. Fall back to homedir-based path.
      root = `${homedir()}/AppData/Local/vault-tools`;
    } else {
      root = `${localAppData}/vault-tools`;
    }
  } else if (plat === 'darwin') {
    root = `${homedir()}/Library/Application Support/vault-tools`;
  } else {
    const xdg = process.env.XDG_DATA_HOME;
    root = xdg && xdg.trim()
      ? `${xdg.trim()}/vault-tools`
      : `${homedir()}/.local/share/vault-tools`;
  }
  return resolve(root).replace(/\\/g, '/');
}
