import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VaultIndex } from '../vault-index.js';
import { computeSpecDrift } from '../spec-drift.js';

/**
 * vault_spec_drift — deterministic backstop for changelog discipline.
 *
 * Cross-checks each create-skill's spec-requirements manifest in
 * .claude/skills/new-<kind>/SKILL.md against SYSTEM/spec_changelog.yaml and flags
 * requirements that exist in a skill but were never logged in the changelog
 * (the silent miss that makes epoch-conformance audits misattribute quality —
 * ledger-protocol §4.1). Reads files from disk; independent of the note index.
 */
export function registerSpecDriftTool(server: McpServer, index: VaultIndex): void {
  server.tool(
    'vault_spec_drift',
    'Detect drift between create-skill requirement manifests and SYSTEM/spec_changelog.yaml. ' +
      'For each .claude/skills/new-*/SKILL.md spec-requirements block, verifies every declared ' +
      'requirement has a changelog entry (ERROR manifest-requirement-without-changelog when not). ' +
      'Also flags orphan changelog entries, missing manifests (backfill candidates), and malformed ' +
      'blocks. The deterministic backstop under the changelog-enforcement reminder hooks. ' +
      'Harness-neutral; no arguments — always scans the whole vault.',
    {},
    async () => {
      const result = computeSpecDrift(index.vaultRoot);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
