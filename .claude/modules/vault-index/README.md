# vault-index module

Обёртка над структурным MCP-сервером волта. Сам сервер документирован в `SYSTEM/MCP_Server_Design.md`.

## Что делает (v0.1.0)

- Verify: source MCP-сервера на месте (`.claude/mcp-server/package.json`, `src/`).
- Build: если `dist/` отсутствует — запускает `npm install && npm run build`.
- Sub-block в CLAUDE.md: добавляет короткое описание для агента (что есть `vault-index`, какие tools предоставляет).
- Pишет `.installed` маркер.

## Зависимости

- `core` (нужен outer managed-block в CLAUDE.md).
- Node.js ≥20 (проверяется `core`).
- npm в PATH.

## Что предоставляет

- Mcp_server `vault-index` — будет зарегистрирован в `~/.claude.json` и `opencode.json` модулями `harness-*` (когда они появятся).
- 11 MCP tools (lint, broken-links, orphans, duplicate-links, query, backlinks, note-profile, stats, reindex, lookalike-peers, ...).

## Запланировано

- Миграция: source → `.claude/modules/vault-index/mcp/`, install-копия → `.claude/mcp-servers/vault-index/`. Делается синхронно с `harness-claude-code` модулем (чтобы не сломать регистрацию).
- `update.mjs` — поднимает версию через `npm install` + rebuild.
- `remove.mjs` — Phase 7.

## Ограничения v0.1.0

- Пока MCP-сервер регистрируется в `~/.claude.json` вручную (как описано в `SYSTEM/MCP_Server_Design.md` → «Регистрация в Claude Code»). Автоматическая регистрация — в `harness-claude-code`.
- `provides.mcp_server` — placeholder-значение (имя строкой). Когда появится `harness-claude-code`, формат расширится до полной структуры (command, args, env).
