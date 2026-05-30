---
description: >
  One-shot migration of vault-index MCP server from legacy layout (.claude/mcp-server/) to canonical layout (.claude/modules/vault-index/mcp/). Atomic: backups taken, automatic rollback on failure. Updates ~/.claude.json registration to point at new binary path. Use when /init-vault status reports vault-index layout as 'legacy' and you want to migrate, or when copying portable bundle to new vaults requires source-in-module layout. See SYSTEM/Vault_Bootstrap_Architecture.md and SYSTEM/Vault_Bootstrap_Roadmap.md.
---
Invoke the `migrate-vault-index` skill via the skill tool NOW.

User's arguments: $ARGUMENTS

Execute the skill's instructions IMMEDIATELY using the arguments above. Do not just acknowledge — perform the actions and report the result.
