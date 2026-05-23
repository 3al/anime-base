# core module

Обязательная база bootstrap-фреймворка. Все остальные модули неявно зависят от того, что core отработал успешно — это означает «волт валиден и готов принимать инфру».

## Что делает (v0.3.0)

- Verify: проверяет `.obsidian/` маркер.
- Manage CLAUDE.md outer managed-block (контейнер для sub-блоков других модулей).
- Manage `.gitignore` managed-block (правила для `.installed` маркеров и MCP build-артефактов).
- Pишет `.installed` state-маркер с версией.

## Что предоставляет другим модулям

`lib/managed_block.mjs`:
- `ensureManagedBlock(filePath, content, style)` — outer-block management (для CLAUDE.md и .gitignore).
- `ensureSubBlock(filePath, moduleName, content)` — sub-block внутри outer CLAUDE.md блока. Используется модулями типа `vault-index`, `harness-*` чтобы вписать свою секцию документации.
- `removeSubBlock(filePath, moduleName)` — для remove-handler'ов модулей.
- `hasOuterBlock(filePath, style)` — проверка наличия outer-блока (для status-handler'ов).

## Запланировано (Phase 2+)

- Создание `SYSTEM/` директории.
- Mandatory governance-templates: `Metadata_schema.md`, `Tag_taxonomy.md`, `Naming_conventions.md`, `Vault_architecture.md`.
- `update.mjs` (после первой реальной миграции).
- `remove.mjs` (Phase 7).
- `Note_Body_Structure.md` template (Phase 3, после дизайна RAG).

## Контракт операций

См. `SYSTEM/Vault_Bootstrap_Architecture.md` → раздел «Контракт операций».

Status возвращает `module_status`:
- `installed` — всё на месте, версии совпадают.
- `outdated` — маркер есть, но версия устарела (запустить install).
- `partial` — маркер есть, версия совпадает, но managed-блоки отсутствуют (restored install).
- `missing` — маркера нет (первичный install).
- `missing_prerequisite` — нет `.obsidian/`, не Obsidian-волт.
