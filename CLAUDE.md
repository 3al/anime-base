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
- Установлено в `.claude/skills/`: `fix-links`, `audit-note`, `new-note`, `rename-note`, `verify`, `expand-stub`, `add-note-kind`, `harness-agnostic-audit`, `vision-gate-audit`, `audit-by-creator`.
- Каждый скилл управляется фреймворком через `.managed` маркер. Пользовательские правки в SKILL.md = переход в статус `unmanaged` (повторный `/init-vault` не перезаписывает).
- `/add-note-kind` создаёт пользовательский `/new-<kind>` скилл без `.managed` маркера — он живёт независимо от фреймворка, переустановки `skills-common` его не трогают.

### `/new-note` routing

Skill `/new-note` использует секцию `folders` в `.claude/vault-manifest.yaml` для классификации новой заметки. Если ни одна папка не подходит — skill предложит создать новую и автоматически зарегистрирует её в манифесте + `SYSTEM/Vault_architecture.md`.

**Не создавайте заметки руками вне зарегистрированных папок** — сначала зарегистрируйте новую папку через `/new-note` или ручной правкой манифеста.
<!-- END: module:skills-common -->
<!-- BEGIN: module:vault-index -->
**MCP-сервер `vault-index`** (модуль `vault-index` v0.9.1):
- Структурный индекс волта — frontmatter, граф ссылок, таблицы, инвентарь вложений, lint, query.
- 17 MCP tools: `vault_lint`, `vault_broken_links`, `vault_orphans`, `vault_duplicate_links`, `vault_duplicate_basenames`, `vault_query`, `vault_backlinks`, `vault_note_profile`, `vault_stats`, `vault_reindex`, `vault_image_status`, `vault_add_image`, `vault_lookalike_peers`, `vault_text_mentions`, `vault_asymmetric_links`, `vault_spec_drift`, `vault_tag_health`.
- `vault_lint` принимает опциональные `reciprocityPairs` (из `vault-manifest.yaml::reciprocity_pairs`) + `asymmetricSeverity` (из `asymmetry_severity`, дефолт WARN) → асимметрия всплывает `asymmetric-link` issue. Та же engine-логика, что у `vault_asymmetric_links` (`src/asymmetric.ts`). Также `linkCap` (из `link_cap`, дефолт 15; `null` → отключить) — порог `too-many-links`; `maxTags` (из `max_tags`, дефолт 10) — порог `too-many-tags`.
- **Дисциплина тегирования** (v0.9.0–0.9.1, Roadmap §29/§32): канон тегов — машинный `SYSTEM/tag_taxonomy.yaml` (yaml=SSOT; `Tag_taxonomy.md` генерируется из него). `non-canonical-tag` (тег вне канона) — structural-WARN (фазовый флип в ERROR-gating позже, только при `canonSource='yaml'`). Tool `vault_tag_health` (vault-wide): детерминированные `ghost` (канон с 0 использований) / `noncanon_summary`; эвристические `singletons` (count==1) / `under_tag_discord` (фасеты из `tag_facet_fields`; `under_tag_mode` `majority`|`any`|`off`, дефолт **majority** — флаг только near-universal тега, пропущенного у ≤`under_tag_max_missing` при доле ≥`under_tag_present_fraction`; кандидаты ранжируются по confidence, кап `under_tag_limit`). Ничего не гейтит structural-green; ghost/noncanon advisory при `canon_unreliable` (нет yaml-SSOT). Правила тегирования + критерий приёма — `.claude/skills/audit-by-creator/references/tag-discipline.md`.
- **Lint два класса** (v0.7.0, Roadmap §22–§23): каждый issue несёт `class` — `structural` (детерминированный, ~0 FP; «зелёное по структуре» = `summary.structural_green`, нет structural-ERROR) или `heuristic` (нечёткий WARN, отдельный поток, не влияет на structural-green). Разведение, чтобы шум эвристик не эродировал доверие к структурному сигналу.
- **Structural-правила** (v0.7.0): `broken-table-row` (always-on — ячейка-счёт строки ≠ шапке / неэкранированный `\|` в `[[...]]` внутри таблицы; ловит разорванный рендер каста, который граф-проверки не видят); `cover-ref-mismatch` (default-on — ссылка обложки на `.jpg` при файле `.jpeg` и обратно, против инвентаря вложений; `coverField`/`coverEmbedSuffix`, `cover_field: null` отключает); `name-surface-mismatch` (opt-in `nameSurfacePairs` из `name_surface_pairs` — basename должен СОДЕРЖАТЬ все токены поля-имени, order/diacritic-нечувствительно; лишние токены вроде титулов допустимы); `missing-required-tag` (opt-in `requiredTagsByKind` из `required_tags_by_kind` — заменил прежний хардкод kind→tags); `empty-tags` (v0.8.0, always-on — пустой `tags` → WARN; §24-бэкстоп: детерминированный консистентный сигнал, не гейтит structural-green).
- **Heuristic-правила** (opt-in, on-demand чтение тела): `user-only-fabricated` (`userOnlySections`/`userOnlyStubWhitelist` — USER-ONLY-секция не-стаб при `co_authored`=модель и `quality≠verified`); `mixed-script-prose` (`proseScript`, напр. `cyrillic` — инородный скрипт в прозе; capitalized-имена/bold/wikilinks/код экранируются от FP); `tooling-vocab-in-prose` (v0.8.0, `toolingVocabFieldNames`/`toolingVocabStatePhrases`/`toolingVocabFlagSkillCommands` из `tooling_vocab` — внутренний bookkeeping волта в читательской прозе: имена frontmatter-полей, vault-state фразы «карточек нет», имена скиллов `/...`; маскирование как у mixed-script + USER-ONLY-стаб-whitelist). Тема-нейтрально: скрипт/секции/поля/паттерны — параметры манифеста, не хардкод.
- `vault_query` (§20): кроме core-полей — generic where по любому frontmatter-полю: `fieldEquals`/`fieldGte`/`fieldIn` (dot-path, напр. `images.cover`), `fields` возвращает запрошенные `extra`-поля в проекции.
- `vault_duplicate_basenames` — детект заметок с одинаковым basename в разных папках (Obsidian резолвит WikiLinks по basename без учёта папки → коллизия молча ломает граф). Lint-backstop к create-time страж-проверке в `/new-<kind>`.
- `vault_spec_drift` — детерминированный backstop changelog-дисциплины (ledger-protocol §4.1): сверяет spec-requirements манифест каждого `/new-<kind>/SKILL.md` с `SYSTEM/spec_changelog.yaml`, флагает `manifest-requirement-without-changelog` (требование объявлено, но не залогировано → аудит ложно штрафует старые карточки), `missing-manifest` (скилл без блока — кандидат на бэкфилл), `changelog-entry-without-manifest`. Harness-нейтрален. В CC дополняется live-reminder PostToolUse-hook'ом (harness-claude-code); в Opencode — backstop-only (upstream #13574).
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
**Harness: Claude Code** (модуль `harness-claude-code` v0.5.0):
- Регистрирует MCP-серверы из всех модулей манифеста, у которых `module.yaml` объявляет `provides.mcp_server`. Шаблонные переменные (`{vault_root}`, `{module_dir}`, `{module_dist}`, `{module_bin}`) резолвятся при патче.
- Записи живут под project-scope: `projects["<абс_путь_волта>"].mcpServers["<имя_сервера>"]` в `~/.claude.json`. Имена серверов — без vault-slug суффикса (изоляция через project key).
- Backup при изменении конфига — `~/.claude.json.bak.<ISO-timestamp>` (последние 5 хранятся, ротация автоматическая).
- **spec-changelog enforcement (v0.5.0):** install также патчит `<vault>/.claude/settings.json` → `hooks.PostToolUse` (matcher `Edit|Write|MultiEdit`, command → `hooks/spec-reminder.mjs`) — аддитивный merge с backup, пользовательские хуки сохраняются, идемпотентно. Хук при правке spec-requirements блока в `.claude/skills/new-*/SKILL.md` впрыскивает reminder синхронизировать `SYSTEM/spec_changelog.yaml` (ledger-protocol §4.1). Детерминированный backstop в обеих harness — tool `vault_spec_drift`.
- Reconcile-семантика — add/update only. Удаление модуля из манифеста НЕ вычищает регистрацию из `~/.claude.json` автоматически — нужно вручную.
- Управляется через `/init-vault`. Ручные правки соответствующих ключей будут перезаписаны при следующем install.
<!-- END: module:harness-claude-code -->
<!-- BEGIN: module:harness-opencode -->
**Harness: Opencode** (модуль `harness-opencode` v0.1.0):
- Регистрирует MCP-серверы из всех модулей манифеста, у которых `module.yaml` объявляет `provides.mcp_server`. Шаблонные переменные (`{vault_root}`, `{module_dir}`, `{module_dist}`, `{module_bin}`) резолвятся при патче. Тот же контракт, что у harness-claude-code, — общий `core/lib/mcp_registry.mjs`.
- Записи живут под top-level: `mcp["<имя_сервера>"]` в `<vault>/opencode.json`. Opencode-specific формат entry: `command: ["node", "<path>"]` (массив, не строка), `environment` вместо `env`, `type: "local"` для stdio, `enabled: true`.
- Backup при изменении конфига — `<vault>/opencode.json.bak.<ISO-timestamp>` (последние 5, ротация автоматическая).
- Bulk wrapper generation: при install сканирует `<vault>/.claude/skills/*/SKILL.md`, для каждого пишет `.opencode/commands/<name>.md` через `core/lib/opencode_wrappers.mjs::buildWrapperContent`. Wrapper — тонкий императивный trigger (`Invoke ... NOW`, `IMMEDIATELY`), без него slash-вызов в Opencode даёт passive load. Idempotent: обновляет только при diff (description-drift после skill rewrite).
- Reconcile-семантика — add/update only. Удаление модуля из манифеста НЕ вычищает регистрацию из `opencode.json` автоматически — нужно вручную. То же для wrapper'ов удалённых скиллов.
- Управляется через `/init-vault`. Ручные правки соответствующих ключей будут перезаписаны при следующем install.
<!-- END: module:harness-opencode -->
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
| `STUDIOS/` | Карточки анимационных студий-производителей |
| `MANGA/` | Карточки манги/произведений |

## Правила скачивания и валидации изображений

Применяются **во всех скиллах волта, работающих с изображениями** — генерируемых `/new-<kind>` для kind'ов с галереей и любых аудит-скиллах, которые проверяют или подбирают фото.

### Когда применяется vision-gate

Gate нужен **только** скиллам, которым требуется **визуальное суждение** о картинке: скачать и подобрать постер/обложку, классифицировать ракурс или качество, верифицировать соответствие («та ли это картинка»), оценить контент. Признак — скилл **открывает картинку через Read, чтобы принять решение**.

Скилл, который лишь **механически укладывает готовый файл** (роль задаёт пользователь, проверки только программные — тип, размер, габариты, **без Read-для-решения**), визуального суждения не делает → **gate не применяется**, достаточно программной валидации (тип + размер). Не навешивать на такой скилл ни probe, ни STOP на текстовой модели. Это ось «нужно ли визуальное суждение?», а не «про фото ли скилл вообще» — один и тот же ярлык (`add-image`) может и классифицировать ракурс (gate нужен), и просто укладывать файл с ролью от пользователя (gate не нужен).

### Vision-gate (мультимодальная модель)

Классификация, визуальная верификация и подбор изображений возможны **только** при реальном восприятии картинки. Текстовая модель этого не умеет; если дать ей эвристический fallback (имя файла, URL, подпись) — она тихо выдаст некачественный результат. Поэтому gate активный, а не декларативный.

Проходить **в точке начала работы с изображениями** (не как декларация в начале — как реальная проверка):

1. Если скилл поддерживает флаг `--no-images` / `-n` и он задан → пропустить всю работу с изображениями, идти дальше. Gate и probe не нужны.
2. **Pre-flight probe — ДО любого скачивания.** Открыть через Read ассет `.claude/assets/vision_probe.png` (генерится core install; крошечный PNG с простой фигурой) и определить мультимодальность по **поведению Read**, а не по «угадал ли я фигуру»:
   - Read вернул визуальный контент (видно фигуру и цвет) → модель **мультимодальна** → переходить к скачиванию постеров нормально (правила curl/валидации ниже). Вердикт можно переиспользовать в пределах сессии — пробивать повторно на каждом фото-шаге не обязательно.
   - Read дал ошибку / только метаданные-байты / никакого визуала → модель **слепая** → **СТОП на работе с фото, ноль сетевых попыток**:
     - **Запрещено** классифицировать, подбирать или оценивать изображения по имени файла, URL или подписи. Это не запасной путь, а источник брака.
     - Сообщить пользователю: «Текущая модель не мультимодальная — визуальная проверка фото невозможна. Переключитесь на мультимодальную модель или запустите с флагом `--no-images`, чтобы пропустить изображения.»
     - Скиллы, где работа с фото — лишь **часть** (аудит заметки, дополнение карточки): выполнить текстовую часть (lint, факты, контент), фото-шаг **пропустить** с явной пометкой в отчёте, а не делать на эвристике.
     - Скиллы, **целиком про фото** (создание карточки с обязательной галереей без `--no-images`, добавление изображения с классификацией ракурса, аудит изображений): остановиться до переключения модели.

> Probe-ассет расцепляет проверку модальности от боевого скачивания: слепая модель узнаёт о своей слепоте **до** первой сетевой попытки, без скачать-Read-удалить. Граница честная — галлюцинацию восприятия probe не исключает на 100% (та же граница, что и при пробе на боевом постере), но детерминированный сигнал есть: на не-мультимодальном харнессе Read картинки даёт ошибку/метаданные, а не визуал. «Назови фигуру/цвет» — вторичная подстраховка, не основной критерий.

### Adult-контент: укладка по провенансу (gate НЕ применяется)

Для карточек с `content_rating ∈ {nsfw, explicit}` приобретение изображений (обложка тайтла, портрет персонажа) — **механическая укладка по провенансу**, а не визуальный подбор. Поэтому к ней vision-gate **не применяется** (та же ось «нужно ли визуальное суждение?», что выше): identity картинки гарантирована **источником**, а не Read-опознанием.

1. **Источник — id-locked CDN.** Обложка: AniList `coverImage.extraLarge`/MAL `og:image` (по anime-id); портрет персонажа: AniList `character/<id>` (по character-id). URL заперт на id сущности → это заведомо нужная картинка, опознавать глазами нечего.
2. **Валидация — только программная:** HTTP-код, тип/сигнатура (`file`), размер (> порога). Битый файл/не-изображение → отбросить.
3. **Вшивать без probe и без графичного Read.** Провенанс заменяет identity-проверку gate'а; content-appropriateness не оценивается (пользователь сознательно каталогизирует adult своей библиотеки — это его контент, не предмет суждения). Probe не нужен (визуального суждения нет вовсе).
4. **Граница — НЕ в gate, а в ПРЕДМЕТЕ.** Единственный жёсткий предел (никакого сексуального контента с участием изображённых несовершеннолетних) — **subject-based**: он смотрит на то, **центрирована ли работа** на сексуализации несовершеннолетних (премиса/сюжет/каст по AniList), и срабатывает **независимо от механизма** — провенанс, ручная подача файла, флаг пропуска gate его НЕ отключают (он про то, что собирается в волт, а не про то, смотрел ли я на файл). Легальный adult-контент со взрослыми участниками укладывается без трения и без «цензуры»; контент с сексуализацией несовершеннолетних не укладывается **ни одним** путём.

### Скачивание

Использовать `curl` с проверкой HTTP-кода:
```bash
curl -L -f -o "<путь>" -w '%{http_code}' "<URL>"
```
Флаг `-f` заставляет curl вернуть ошибку при HTTP 4xx/5xx вместо сохранения HTML-страницы ошибки.

### Обязательная валидация после скачивания

1. **Проверить тип файла**: `file <путь>`.
   - Допустимо: JPEG, PNG, GIF, WebP.
   - Битый файл (HTML, XML, ASCII text, data, empty) → удалить, попробовать другой URL.

2. **Проверить размер**: `ls -la <путь>`.
   - Файл < 1 КБ → скорее всего не картинка, удалить.

3. **НИКОГДА** не отправлять файл на визуальную оценку (Read tool) без прохождения проверок 1–2. Битое изображение отравляет контекст модели и вызывает ошибку `"Could not process image"` на все последующие запросы в сессии.

### При ошибке `"Could not process image"`

- **НЕ пытаться** повторно оценить тот же файл — он уже отравил контекст.
- Удалить файл.
- Скачать новое изображение с другого URL.
- Валидировать заново (п. 1–2) перед визуальной оценкой.

<!-- harness-agnostic-conventions:start -->
## Skills authoring conventions

Скиллы и инструкции в этом волте — **harness-agnostic**. При создании или редактировании любого `.claude/skills/*/SKILL.md`, файлов в `SYSTEM/` и самого `CLAUDE.md` соблюдай конвенции из `docs/Vault_Bootstrap_Architecture.md § Конвенция формата skills → Body content` (документ в bootstrap-репо). Цель — код одинаково работает в Claude Code, Opencode и любых будущих совместимых harness'ах без переписывания.

Правило не зависит от того, в каком harness ты сейчас работаешь: при работе из CC модель пишет код, который сразу заработает в Opencode, и наоборот.

Кратко (правила R1–R8):

| Pattern (harness-specific) | Harness-agnostic форма |
|---|---|
| `` `mcp__<server>__<tool>(args)` `` | `` <server> MCP, tool `<tool>(args)` `` |
| «через AskUserQuestion» | «структурированным multi-choice вопросом» |
| `WebFetch` / `WebSearch` (procedural) | «web fetch» / «web search» (lowercase) |
| `TaskCreate` / `TaskUpdate` (procedural) | «через TODO-список» / «обновить TODO-список» |
| `subagent_type=Explore` | «sub-agent типа Explore» |
| `$1` / `$2` / `$3` в body | «первый аргумент» / «второй аргумент» (NL). `$ARGUMENTS` оставляем — universal |

**Не трогать:**
- Casual references к universal tools (`Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`).
- Frontmatter поля (`argument-hint`, `model:`, `disable-model-invocation:` — Opencode тихо игнорирует).
- `$ARGUMENTS` placeholder.

**Workflow:**
- Новый тематический `/new-<kind>` скилл создаётся через `/add-note-kind` — правила применяются автоматически (КРИТИЧНО #11 в add-note-kind), включая безусловную генерацию `.opencode/commands/<name>.md` wrapper'а.
- Ручная правка SKILL.md — следить за паттернами выше; периодически запускать `/harness-agnostic-audit` для верификации.
- При появлении нового harness-specific tool — обновить `docs/Vault_Bootstrap_Architecture.md` (canonical) и скилл `harness-agnostic-audit` (mirror).

Этот блок поддерживается скиллом `/harness-agnostic-audit` (и модулем `harness-opencode` при /init-vault). Ручные правки между маркерами будут перезаписаны на следующем запуске.
<!-- harness-agnostic-conventions:end -->
