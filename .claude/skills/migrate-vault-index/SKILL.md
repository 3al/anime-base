---
name: migrate-vault-index
description: >
  One-shot migration of vault-index MCP server from legacy layout
  (.claude/mcp-server/) to canonical layout (.claude/modules/vault-index/mcp/).
  Atomic: backups taken, automatic rollback on failure. Updates ~/.claude.json
  registration to point at new binary path. Use when /init-vault status reports
  vault-index layout as 'legacy' and you want to migrate, or when copying
  portable bundle to new vaults requires source-in-module layout. See
  SYSTEM/Vault_Bootstrap_Architecture.md and SYSTEM/Vault_Bootstrap_Roadmap.md.
disable-model-invocation: false
---

# /migrate-vault-index — Атомарная миграция vault-index на canonical layout

Перемещает MCP source из `.claude/mcp-server/` (legacy) в `.claude/modules/vault-index/mcp/` (canonical), обновляет регистрацию в `~/.claude.json` под новый путь, делает backup всего критичного перед началом, откатывает изменения при ошибке любого шага.

**Когда запускать:**
- `/init-vault --check` показал у `vault-index` `layout: legacy` и есть желание перейти на canonical.
- Готовишься переносить portable bundle (`.claude/modules/`) на другой волт — там source должен быть внутри модуля.

**Когда НЕ запускать:**
- `layout: canonical` — уже мигрирован, скилл сам это обнаружит и выйдет no-op.
- `layout: missing` — нет source ни в одной локации, сначала установить vault-index.
- `layout: mixed` — обе локации существуют (странное состояние); скилл выйдет с warning, требуется ручной разбор.

## Что делает

Запускает `migrate.mjs` — детерминированный Node.js-скрипт:

1. **Pre-flight checks**:
   - `.obsidian/` существует.
   - `.claude/modules/vault-index/module.yaml` существует.
   - Legacy `.claude/mcp-server/` существует.
   - Canonical `.claude/modules/vault-index/mcp/` НЕ существует.
   - Git репозиторий инициализирован (для `git mv`).

2. **Backup**: явно копирует `~/.claude.json` → `~/.claude.json.bak.pre-migrate.<ISO>` (отдельно от ротируемых backup'ов harness-claude-code).

3. **git mv** `.claude/mcp-server` → `.claude/modules/vault-index/mcp` (сохраняет git history).

4. **Build** (если `dist/` отсутствует в новом месте): `npm install && npm run build` в `.claude/modules/vault-index/mcp/`.

5. **Re-install vault-index** через `ops/install.mjs` — модуль детектирует `canonical` layout и обновляет sub-block в CLAUDE.md.

6. **Re-install harness-claude-code** через его `ops/install.mjs` — детектирует mismatch старого binary path в `~/.claude.json`, делает свой backup и обновляет регистрацию на новый путь.

7. **Verification**: статусы `vault-index` и `harness-claude-code` должны быть `installed` без warnings про layout.

## Rollback при ошибке

Если любой шаг 3-7 фейлит:
- Reverse `git mv` (если успел произойти) — `git mv .claude/modules/vault-index/mcp .claude/mcp-server`.
- Restore `~/.claude.json` из pre-migrate backup'а.
- Сохранить детальный error log с точкой провала.

**После rollback'а волт возвращается к исходному состоянию.** Markers модулей и sub-blocks могут потерять часть актуальности — следующий обычный `/init-vault` это починит.

## Аргументы

- `--dry-run` — только pre-flight checks и план, без реальных операций.

## Что делать

1. Запустить migrate.mjs:
   ```bash
   node .claude/skills/migrate-vault-index/migrate.mjs <<EOF
   {
     "vault_root": "<абсолютный путь к корню волта>",
     "dry_run": false,
     "harness": ["claude-code"],
     "platform": "<win32|darwin|linux>"
   }
   EOF
   ```
2. Распарсить JSON-выход.
3. **Финальный отчёт** (по тому же контракту, что `/init-vault` Шаг 7):
   - Итог: успешная миграция / no-op / rollback / unrecoverable error.
   - Список выполненных шагов (`actions`).
   - Все `warnings` дословно.
   - Все `next_steps` дословно — критично, в ней инструкция перезапустить Claude Code.

## Критичные моменты

1. **Перезапуск Claude Code обязателен после успешной миграции** — config обновлён, но запущенная сессия удерживает старый MCP. Указать пользователю явно в финальном отчёте.
2. **На Windows** `git mv` с открытым файлом MCP-сервера может упасть, если процесс блокирует файл (зависит от опций открытия). Это маловероятно для Node.js, но возможно. Скрипт в этом случае вернёт error без mutation.
3. **Не запускать migrate если недавно делали backup commit** — rollback через `git mv` не очистит маркеры в индексе если что-то пошло не так и пользователь сам commit'нул промежуточное состояние.
