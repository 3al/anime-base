import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VaultIndex } from './vault-index.js';
import { registerLintTool } from './tools/vault-lint.js';
import { registerBrokenLinksTool } from './tools/vault-broken-links.js';
import { registerOrphansTool } from './tools/vault-orphans.js';
import { registerDuplicateLinksTool } from './tools/vault-duplicate-links.js';
import { registerDuplicateBasenamesTool } from './tools/vault-duplicate-basenames.js';
import { registerQueryTool } from './tools/vault-query.js';
import { registerBacklinksTool } from './tools/vault-backlinks.js';
import { registerNoteProfileTool } from './tools/vault-note-profile.js';
import { registerStatsTool } from './tools/vault-stats.js';
import { registerReindexTool } from './tools/vault-reindex.js';
import { registerImageStatusTool } from './tools/vault-image-status.js';
import { registerAddImageTool } from './tools/vault-add-image.js';
import { registerLookalikePeersTool } from './tools/vault-lookalike-peers.js';
import { registerTextMentionsTool } from './tools/vault-text-mentions.js';
import { registerAsymmetricLinksTool } from './tools/vault-asymmetric-links.js';
import { registerSpecDriftTool } from './tools/vault-spec-drift.js';
import { registerTagHealthTool } from './tools/vault-tag-health.js';

// VAULT_ROOT is supplied by the harness MCP registration ({vault_root} template).
// No baked-in default: guessing a path silently indexes the wrong vault — fail loud.
const VAULT_ROOT = process.env.VAULT_ROOT;
if (!VAULT_ROOT) {
  console.error('vault-index: VAULT_ROOT env var is required (set by the harness MCP registration). Refusing to guess a vault path.');
  process.exit(1);
}

const server = new McpServer({
  name: 'vault-index',
  version: '1.0.0',
});

const index = new VaultIndex(VAULT_ROOT);

// Register all 17 tools
registerLintTool(server, index);
registerBrokenLinksTool(server, index);
registerOrphansTool(server, index);
registerDuplicateLinksTool(server, index);
registerDuplicateBasenamesTool(server, index);
registerQueryTool(server, index);
registerBacklinksTool(server, index);
registerNoteProfileTool(server, index);
registerStatsTool(server, index);
registerReindexTool(server, index);
registerImageStatusTool(server, index);
registerAddImageTool(server, index);
registerLookalikePeersTool(server, index);
registerTextMentionsTool(server, index);
registerAsymmetricLinksTool(server, index);
registerSpecDriftTool(server, index);
registerTagHealthTool(server, index);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('vault-index MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
