# Anime_Base

<!-- BEGIN: managed by /init-vault -->
<!--
  Этот блок управляется /init-vault — содержимое внутри маркеров перезаписывается
  при каждом запуске. Контент за пределами BEGIN/END не трогается.

  Модули вписывают свои sub-блоки внутрь этого блока через парные маркеры
  с префиксом "module:" (см. документацию по архитектуре фреймворка). НЕ используйте
  вложенные HTML-комментарии — они ломают рендеринг.

  Текущий состав инфраструктуры — в .claude/vault-manifest.yaml.

  Governance-документы волта (правила метаданных, тегов, линковки, именования):
  - SYSTEM/Metadata_schema.md
  - SYSTEM/Tag_taxonomy.md
  - SYSTEM/Naming_conventions.md
  - SYSTEM/Vault_architecture.md
  - SYSTEM/Audit_checklist.md
  - SYSTEM/Linking_guidelines.md

  Шаблоны seedятся модулем `core` при первом /init-vault. После seed'а файлы
  принадлежат пользователю — фреймворк их не перезаписывает.
-->
<!-- BEGIN: module:skills-common -->
**Тема-нейтральные скиллы** (модуль `skills-common`):
- Установлено в `.claude/skills/`: `fix-links`, `audit-note`, `new-note`, `rename-note`, `verify`, `expand-stub`, `add-note-kind`.
- Каждый скилл управляется фреймворком через `.managed` маркер. Пользовательские правки в SKILL.md = переход в статус `unmanaged` (повторный `/init-vault` не перезаписывает).
- `/add-note-kind` создаёт пользовательский `/new-<kind>` скилл без `.managed` маркера — он живёт независимо от фреймворка, переустановки `skills-common` его не трогают.

### `/new-note` routing

Skill `/new-note` использует секцию `folders` в `.claude/vault-manifest.yaml` для классификации новой заметки. Если ни одна папка не подходит — skill предложит создать новую и автоматически зарегистрирует её в манифесте + `SYSTEM/Vault_architecture.md`.

**Не создавайте заметки руками вне зарегистрированных папок** — сначала зарегистрируйте новую папку через `/new-note` или ручной правкой манифеста.
<!-- END: module:skills-common -->
<!-- BEGIN: module:vault-index -->
**MCP-сервер `vault-index`** (модуль `vault-index` v0.1.0):
- Структурный индекс волта — frontmatter, граф ссылок, lint, query.
- 11 MCP tools: `vault_lint`, `vault_broken_links`, `vault_orphans`, `vault_duplicate_links`, `vault_query`, `vault_backlinks`, `vault_note_profile`, `vault_stats`, `vault_reindex`, `vault_lookalike_peers`.
- Source: `.claude/modules/vault-index/mcp/` (canonical layout). Полная архитектура: `SYSTEM/MCP_Server_Design.md`.
- Регистрация в `~/.claude.json` / `opencode.json` — через harness-* модули (см. `.claude/vault-manifest.yaml`).
<!-- END: module:vault-index -->
<!-- BEGIN: module:vault-semantic -->
**MCP-сервер `vault-semantic` + skill `/vault-rag`** (модуль `vault-semantic` v0.3.1):
- Семантический поиск по волту (L2 — bge-m3 dense + BM25 c pymorphy3/snowball лемматизацией, гибрид RRF через SQLite/sqlite-vec). Архитектура: `docs/RAG_Architecture.md`.
- 4 MCP tools: `vault_semantic_search`, `vault_semantic_reindex`, `vault_semantic_stats`, `vault_semantic_warmup`.
- v0.3.1: добавлен skill `/vault-rag` (L3-роутер). Pure LLM-driven, устанавливается в `.claude/skills/vault-rag/` с `.managed` marker. Использует vault-index (L1) + vault-semantic (L2) с heuristic-based routing'ом. См. `SKILL.md` скилла для контракта.
- v0.3.0 (Phase 4.7): транспорт через тонкий Node stdio-shim (`shim/index.mjs`). Shim спавнит Python в `streamable-http` (stateless) на свободном порту, проксирует stdin JSON-RPC ↔ HTTP POST `/mcp`. Обходит Windows MSVCRT-буферизацию Python stdio через Bun/CC.
- v0.2.0 (Phase 4.6): `search`/`stats` сами подхватывают изменения волта через `incremental_refresh()` — module-level mtime-snapshot + 2s debounce. Ручной `vault_semantic_reindex` нужен только для `scope='full'` (смена chunker / схемы / модели).
- `install_scope: shared`. Heavy-артефакты (venv ~1 GB, bge-m3 ~2 GB, source-копия + shim) — в `$VAULT_TOOLS_HOME/vault-semantic/` (по умолчанию `%LOCALAPPDATA%\vault-tools\` / `${XDG_DATA_HOME:-~/.local/share}/vault-tools/`), один на машину. В волте — только `data/vault.sqlite` + marker `.installed{linked_to}` + `.claude/skills/vault-rag/`. Подробно: `docs/Shared_Install_Architecture.md`.
- Регистрация в `~/.claude.json` / `opencode.json` — через harness-* модули.
<!-- END: module:vault-semantic -->
<!-- BEGIN: module:harness-claude-code -->
**Harness: Claude Code** (модуль `harness-claude-code` v0.2.0):
- Регистрирует MCP-серверы из всех модулей манифеста, у которых `module.yaml` объявляет `provides.mcp_server`. Шаблонные переменные (`{vault_root}`, `{module_dir}`, `{module_dist}`, `{module_bin}`) резолвятся при патче.
- Записи живут под project-scope: `projects["<абс_путь_волта>"].mcpServers["<имя_сервера>"]` в `~/.claude.json`. Имена серверов — без vault-slug суффикса (изоляция через project key).
- Backup при изменении конфига — `~/.claude.json.bak.<ISO-timestamp>` (последние 5 хранятся, ротация автоматическая).
- Reconcile-семантика — add/update only. Удаление модуля из манифеста НЕ вычищает регистрацию из `~/.claude.json` автоматически — нужно вручную.
- Управляется через `/init-vault`. Ручные правки соответствующих ключей будут перезаписаны при следующем install.
<!-- END: module:harness-claude-code -->
<!-- END: managed by /init-vault -->

## Инструменты — обязательное чтение

**Перед использованием любого MCP-tool'а или скилла волта** — прочитай `SYSTEM/Tools_reference.md`. Там полный каталог скиллов, MCP-tools, эмпирические знания об их возможностях (которых нет в описаниях) и таблица «когда какой инструмент выбирать». Это снимает три типовые ошибки:

1. Уходишь в `ToolSearch` / `Grep`, когда уже есть готовый MCP-tool.
2. Используешь Grep там, где `vault_backlinks` / `vault_query` дают точный ответ дешевле и без false positives.
3. Дублируешь работу скилла «руками» вместо одного `/`-вызова.

Если открыл новое свойство tool'а, которого нет в описании — допиши в `Tools_reference.md` (секция «Эмпирические знания»), чтобы оно не растворилось.

## Структура папок

| Папка | Содержимое |
| --- | --- |
| `ANIME/` | Карточки аниме-тайтлов: сериалы, фильмы, OVA |
| `PERSONS/` | Карточки людей из аниме-индустрии: режиссёры, сценаристы, композиторы и т.д. |
| `CHARACTERS/` | Карточки вымышленных персонажей аниме и манги |
