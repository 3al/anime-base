import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VaultIndex } from './vault-index.js';
import { registerLintTool } from './tools/vault-lint.js';
import { registerBrokenLinksTool } from './tools/vault-broken-links.js';
import { registerOrphansTool } from './tools/vault-orphans.js';
import { registerDuplicateLinksTool } from './tools/vault-duplicate-links.js';
import { registerQueryTool } from './tools/vault-query.js';
import { registerBacklinksTool } from './tools/vault-backlinks.js';
import { registerNoteProfileTool } from './tools/vault-note-profile.js';
import { registerStatsTool } from './tools/vault-stats.js';
import { registerReindexTool } from './tools/vault-reindex.js';
import { registerImageStatusTool } from './tools/vault-image-status.js';
import { registerAddImageTool } from './tools/vault-add-image.js';
import { registerLookalikePeersTool } from './tools/vault-lookalike-peers.js';
import { registerTextMentionsTool } from './tools/vault-text-mentions.js';

const VAULT_ROOT = process.env.VAULT_ROOT || 'D:\\Knowledge_Base';

const server = new McpServer({
  name: 'vault-index',
  version: '1.0.0',
});

const index = new VaultIndex(VAULT_ROOT);

// Register all 13 tools
registerLintTool(server, index);
registerBrokenLinksTool(server, index);
registerOrphansTool(server, index);
registerDuplicateLinksTool(server, index);
registerQueryTool(server, index);
registerBacklinksTool(server, index);
registerNoteProfileTool(server, index);
registerStatsTool(server, index);
registerReindexTool(server, index);
registerImageStatusTool(server, index);
registerAddImageTool(server, index);
registerLookalikePeersTool(server, index);
registerTextMentionsTool(server, index);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('vault-index MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
