---
type: guide
domain: system
stability: evolving
priority: high
quality: draft
tags:
  - metadata
  - agent
created: 2026-05-23
updated: 2026-05-23
---

# Инструменты обслуживания vault

Справочник по скиллам и MCP-инструментам, доступным Claude Code для работы с базой знаний об аниме, манге и людях из индустрии.

**Зачем этот файл существует.** Чтобы не уходить в `ToolSearch` или `Grep`-сафари каждый раз, когда нужен инструмент. Сюда же зафиксированы эмпирические знания о возможностях tool'ов, которых нет в их описаниях.

## Скиллы (`.claude/skills/`)

Скиллы вызываются через `/имя` в чате Claude Code или через естественный язык (триггерные фразы).

### Создание контента

| Скилл            | Аргументы                            | Описание |
|------------------|--------------------------------------|----------|
| `/new-anime`     | `<название тайтла>`                  | Создать карточку аниме-тайтла: web search (MAL, AniList, Shikimori) + frontmatter + auto-download постера + cross-update в `PERSONS/*.works[]` и `STUDIOS/*` (gallery-формат). Модель: opus |
| `/new-person`    | `<имя персоны>`                      | Создать карточку человека из аниме-индустрии (режиссёр, сценарист, композитор, продюсер, аниматор, мангака). Cross-update в `ANIME/*.staff[]` + gallery-секция `## Студия и команда`. Модель: opus |
| `/new-character` | `<имя персонажа>`                    | Создать карточку вымышленного персонажа аниме/манги. Auto-download постера + reverse-check секции персонажей в `featured_in` карточках (in-place upgrade text → WikiLink+миниатюра). Модель: opus |
| `/new-studio`    | `<название студии>`                  | Создать карточку анимационной студии-производителя. Auto-download логотипа (Wikimedia/MAL) + cross-update в `ANIME/*.studio` gallery-секции «## Студия и команда». Модель: opus |
| `/new-note`      | `<тема>`                             | Создать заметку общего назначения. Routing через `.claude/vault-manifest.yaml::folders`; делегирует на тематический `/new-<kind>` если папка имеет `create_skill`. Модель: opus |
| `/expand-stub`   | `<файл> [комментарий]`               | Расширить заметку-заглушку до полноценной. Модель: opus |

### Расширение волта

| Скилл              | Аргументы                | Описание |
|--------------------|--------------------------|----------|
| `/add-note-kind`   | `[<slug>]`               | Зарегистрировать новый `note_kind`: патчит `SYSTEM/Metadata_schema.md`, `enums.yaml`, `Linking_guidelines.md`, `Tag_taxonomy.md`, `Vault_architecture.md`, `CLAUDE.md`, `.claude/vault-manifest.yaml`, `.obsidian/types.json` + генерирует `/new-<slug>` скилл. Модель: opus |

### Изображения

| Скилл                   | Аргументы                  | Описание |
|-------------------------|----------------------------|----------|
| `/add-images`           | `<note> <poster\|gallery> <file-or-folder>` | Добавить постер или элементы галереи к существующей заметке. Cross-update embeds в волте (`vault_backlinks`) при смене расширения постера. W=300 для постера, `W=150` для галереи (фиксированные ширины, `\|` escape pipe внутри таблиц). Универсальный для любого `note_kind`. Модель: opus |
| `/remove-gallery-image` | `<note> <index\|all>`      | Удалить одно фото из `## Галерея` по row-major индексу, либо все сразу (`all`). Детектит external embeds через Grep, предлагает multi-choice (delete everywhere / unlink only / cancel) для каждого затронутого файла. Чистая механика, без LLM. Модель: haiku |

### Ревью и качество

| Скилл            | Аргументы                  | Описание |
|------------------|----------------------------|----------|
| `/verify`        | `<файл> [verified\|draft]` | Проставить `co_authored`, `quality`, `updated`. По умолчанию `quality: verified`. Модель: haiku |
| `/audit-note`    | `<файл>`                   | Полный аудит заметки: `vault_lint` (механика) + LLM-проверки (таксономия, ссылки, факт-чек через web search, шумоподавление контента). Модель: opus |
| `/audit-review`  | `<файл>`                   | Аудит секции `## Личный отзыв`: пунктуация, опечатки, форматирование + извлечение `personal_score` / `personal_status` (+ `opening_score` / `ending_score` для anime) из прозы. Kind-agnostic. Модель: opus |

### Ссылки и граф

| Скилл           | Аргументы                                            | Описание |
|-----------------|------------------------------------------------------|----------|
| `/fix-links`    | `[broken\|duplicates\|orphans\|lint\|all] [папка]`   | Batch-починка: сломанные ссылки, дубликаты, сироты, lint. По умолчанию `all`. Модель: sonnet |
| `/rename-note`  | `<старое имя> <новое имя/папка>`                     | Переименовать/переместить заметку, обновить все WikiLinks через `vault_backlinks`, добавить старое имя в `aliases`. Использует `git mv`. Модель: sonnet |

### Семантический поиск (L3 router)

| Скилл         | Аргументы                | Описание |
|---------------|--------------------------|----------|
| `/vault-rag`  | `<вопрос на естественном языке>` | LLM-роутер поверх vault-index (L1, структурный) и vault-semantic (L2, гибридный bge-m3 + BM25). Сам решает каким уровнем отвечать. Модель: opus |

### Инфраструктура

| Скилл                    | Аргументы | Описание |
|--------------------------|-----------|----------|
| `/init-vault`            | —         | Установка/обновление модулей из `.claude/vault-manifest.yaml`. Регистрирует MCP-серверы в `~/.claude.json`, патчит `CLAUDE.md` управляемым блоком, ставит/обновляет тема-нейтральные скиллы (`.managed` маркер). |
| `/migrate-vault-index`   | —         | Одноразовая миграция vault-index MCP-сервера с legacy-layout на canonical. Использовать только если `/init-vault status` явно требует. |

---

## MCP-сервер `vault-index` (L1, структурный)

Персистентный индекс волта: frontmatter, граф ссылок, lint, агрегаты. Все запросы <100ms. Подробнее: `SYSTEM/MCP_Server_Design.md` (если есть в волте — иначе исходники в `.claude/modules/vault-index/`).

### Механические проверки

| Tool                          | Параметры                | Что проверяет |
|-------------------------------|--------------------------|---------------|
| `vault_lint`                  | `{ target?, showAll? }`  | Frontmatter, теги, WikiLinks. Обязательные поля (ERROR), рекомендуемые (WARN), невалидные enum-значения, каноничность тегов, обязательные теги по `note_kind`, лимит ссылок (15) |
| `vault_broken_links`          | `{ folder? }`            | WikiLinks на несуществующие заметки |
| `vault_duplicate_links`       | `{ folder? }`            | Повторные WikiLinks на один target в одном файле |
| `vault_orphans`               | `{ folder? }`            | Заметки без входящих WikiLinks |

### Запросы к индексу

| Tool                          | Параметры                                                                 | Что делает |
|-------------------------------|---------------------------------------------------------------------------|------------|
| `vault_query`                 | `{ type?, domain?, tags?, tagsAny?, quality?, stability?, noteKind?, folder?, hasField?, limit? }` | Фильтр заметок по frontmatter-полям |
| `vault_backlinks`             | `{ note }`                                                                | Обратные ссылки: кто ссылается на заметку. **См. ниже эмпирику про image embeds.** |
| `vault_text_mentions`         | `{ note, noteKinds?, includeTarget? }`                                    | Plain-text упоминания имени/aliases цели в телах других заметок (исключая строки, где уже стоит WikiLink на target). Search terms берутся из frontmatter цели (`name`, `aliases[]`, `name_romaji/english/native`, `title_*`). Unicode word-boundary, пропускает frontmatter / fenced code / inline code / заголовки. Используется в reverse-check create-скиллами (`/new-character`, `/new-anime`, `/new-person`, `/new-studio`) для апгрейда text → gallery WikiLink в sibling-карточках. |
| `vault_note_profile`          | `{ note }`                                                                | Полный профиль: frontmatter + outgoing links + backlinks + lint issues |
| `vault_stats`                 | `{}`                                                                      | Агрегаты по волту: counts по type/domain/quality/тегам |
| `vault_reindex`               | `{ full? }`                                                               | Принудительная переиндексация. Обычно автоматическая через mtime-snapshot |

### Эмпирические знания о tool'ах

**`vault_backlinks` индексирует image embeds.** Принимает имя файла-картинки (`.jpg`, `.png` и т.п.) и возвращает все заметки с `![[filename.ext]]` в теле. `displayText` в ответе содержит ширину из `|<W>` синтаксиса embed'а — её можно сохранить при Edit без отдельного парсинга.

Пример: `vault_backlinks(note="Tanjiro_cover.jpg")` → `[{sourcePath: "ANIME/Demon_Slayer.md", line: 42, displayText: "60"}, ...]`.

Это **не следует** из описания tool'а («Find all notes that link to a given note») — знание получено эмпирически. Используется в `/add-images` шаг 4.5 для cross-update embeds при смене расширения постера.

**`vault_backlinks` — единственный верификатор реципрокности связей.** `vault_text_mentions` по контракту исключает строки, где WikiLink на target уже стоит (идемпотентность реверс-ноги create-скиллов). Побочный эффект: как только одна сторона связи `A → B` стала WikiLink, недостающая обратная `B → A` становится **невидимой** для text-mention-слоя — он её больше не вернёт. Однонаправленная связь «вмораживается». Подсветить её можно только через `vault_backlinks`, который видит WikiLink независимо от того, был ли там когда-то plain-text: сравнение `vault_backlinks(note=A)` и `vault_backlinks(note=B)` даёт расхождение = список асимметричных связей. Применяется в `/new-character` шаг 7.5d (reciprocity backstop форвард-ноги). Vault-wide детектор накопленного долга — кандидат на новый tool в vault-index + под-режим `/fix-links` (см. roadmap).

**Wikimedia Commons требует descriptive User-Agent.** При скачивании изображений с `upload.wikimedia.org` (логотипы студий, infobox-картинки) generic `Mozilla/5.0` даёт 429 даже с одного запроса. Wikimedia [User-Agent policy](https://meta.wikimedia.org/wiki/User-Agent_policy) требует UA вида `<BotName>/<version> (<repo or contact URL>; <email>)`. Также: thumbnail URL'ы (`/thumb/.../<N>px-...`) принимаются только для whitelisted размеров — кастомные (300px и т.п.) дают 400. Безопасно качать оригинал без `/thumb/`. Полная нота — `memory/reference_wikimedia_download_ua_and_thumb_policy.md`. Зафиксировано в `/new-studio` шаг 6.5; `/new-character` и `/new-anime` пока используют generic UA — могут уткнуться, если столкнутся с Wikimedia.

### Tools, унаследованные из общего vault-index и НЕ применяемые в Anime_Base

Эти tool'ы зашиты в vault-index, потому что код шарится с волтами других тематик (mushroom-card и т.п.). В Anime_Base их **не используем** — оставлены как dead code, чтобы случайный вызов не путал:

| Tool                          | Откуда                                |
|-------------------------------|---------------------------------------|
| `vault_lookalike_peers`       | Mushroom-card — двойники грибов       |
| `vault_image_status`          | Mushroom-card — типизированные ракурсы (top/side/habitat) |
| `vault_add_image`             | Mushroom-card — добавление по imageType |

В Anime_Base для постеров используется `/add-images` скилл (frontmatter `images.cover`, не `images.<тип>`).

---

## MCP-сервер `vault-semantic` (L2, гибридный поиск)

Семантический поиск: bge-m3 dense + BM25 с pymorphy3/snowball лемматизацией, гибрид RRF через SQLite/sqlite-vec. Архитектура: `.claude/modules/vault-semantic/docs/RAG_Architecture.md`.

| Tool                       | Параметры                                            | Что делает |
|----------------------------|------------------------------------------------------|------------|
| `vault_semantic_search`    | `{ query, k?, mode?, min_score?, filter?, verbosity?, response_max_chars?, section_path_prefix? }` | Гибридный поиск по смыслу + лексике. Возвращает chunks с score'ом. `mode` ∈ hybrid (default) / bm25 / dense. `k` дефолт 12 (clamp ≤40, hard cap 100) |
| `vault_semantic_reindex`   | `{ scope? }`                                         | Принудительная переиндексация. Обычно НЕ нужна (incremental refresh через mtime-snapshot). Использовать только при смене chunker'а / схемы / модели |
| `vault_semantic_stats`     | `{}`                                                 | Состояние индекса: число чанков, последний refresh |
| `vault_semantic_warmup`    | `{}`                                                 | Прогрев модели и кеша (первый запрос после старта server'а медленный) |

### Эмпирические знания о tool'ах

**Payload-бюджет `vault_semantic_search` (v0.5.1+) меряется в UTF-8 БАЙТАХ, не символах.** Поле `response_max_chars` исторически так названо, но `value` — байтовый бюджет (дефолт 40000 ≈ 40 КБ). В ответе — блок `payload: { verbosity, full_text_count, header_only_count, bounded, max_chars, budget_unit: "utf8_bytes", approx_bytes }`. При превышении бюджета top-N чанков идут full, хвост деградирует в header-only локаторы (`note_path` + `section_path` + `score`, без `text`/metadata); top-1 всегда full. Ранжирование/порядок при урезке не меняются — режется только эмитируемый payload. **`approx_bytes` может слегка превышать `max_chars`** (наблюдалось 40 061 при бюджете 40 000) — это by-design overshoot: top-1 всегда full + хвостовые header-only строки добавляются уже после «закрытия» бюджета. Overshoot структурно ограничен (десятки байт) и НЕ растёт с `k`, так что до точки спила (~68 КБ на кириллице) запас огромный.

**Почему байты важны: кириллица = ~2 UTF-8 байта/символ.** До v0.5.1 бюджет считался в Python str-символах, а harness-cap бьётся по байтам/токенам → 40k символов кириллицы = ~68 КБ на диске → спил в `tool-results/<hash>.txt`. Это был тонкий unit-mismatch баг (не «бюджет не считал metadata», как ошибочно диагностировалось по симптомам — урок в `memory/feedback_diagnose_tool_bug_from_source_not_symptoms.md`).

**`verbosity` (v0.5.0+): lean (default) vs full.** В lean из каждого чанка выкинут `note_metadata.extra` (полный frontmatter карточки: staff[]/aliases/urls/images) — он дублировался на каждом чанке одной заметки и был доминирующим балластом после удаления `frontmatter_prefix`. `verbosity='full'` возвращает `extra` + отладочные `score_components` (dense/bm25/rrf ранги). Для синтеза в `/vault-rag` lean достаточно: `staff[]`/urls/images подтягиваются из самой карточки на Этапе 3 (чтение top-K), `note_path` служит указателем.

**Эмпирика на прозовой кириллице (Anime_Base, ~27 заметок, длинные карточки):** k=12 (дефолт) → ~28 КБ, `bounded:false`, все чанки full, inline. k=20 → ~40 КБ, `bounded:true` (≈17 full + 3 header-only), но **всё ещё inline** (без спила). То есть дефолтный путь полностью помещается в контекст, header-only включается только на эскалации. Если на конкретном запросе нужны все чанки целиком при большом `k` — поднять `response_max_chars` (per-call; через манифест-config пока нельзя — config→env плумбинг отложен в core-follow-up).

---

## Когда какой инструмент выбирать

Часто несколько инструментов могут решить задачу — но один из них выгоднее по точности, скорости и шуму. Эта таблица — антишпаргалка против ложных привычек.

| Задача | Правильный выбор | Не путать с |
|---|---|---|
| Найти embeds картинки по filename | `vault_backlinks(note="<filename.ext>")` | Не Grep по `\!\[\[<name>` — медленнее и не даёт ширину |
| Найти WikiLinks на заметку | `vault_backlinks(note="<basename>")` | — |
| Найти plain-text упоминания заметки (для апгрейда text → WikiLink после создания/переименования) | `vault_text_mentions(note="<target>", noteKinds=[...])` | Не Grep по name — он не знает aliases цели и не фильтрует уже-WikiLinked строки. Не `vault_backlinks` — он находит только существующие WikiLinks. |
| Проверить, что связь двунаправленна (нет вмороженной однонаправленной `A→B` без `B→A`) | `vault_backlinks` обеих сторон + сравнение | Не `vault_text_mentions` — он слеп к строкам, где WikiLink уже стоит, поэтому пропущенную обратную сторону не покажет. |
| Найти заметки по полю frontmatter (`featured_in`, `staff[].person`) | `vault_query` (если поле в схеме) или `vault_backlinks` если поле — foreign-key WikiLink | Не Grep, не semantic |
| Найти заметки про определённую тему (без точного слова) | `vault_semantic_search` | Не Grep — пропустит парафраз/синонимы |
| Найти точное слово/имя в теле волта | `Grep` | Не `vault_semantic_search` — лишний шум на лексическом матче |
| Узнать структурное состояние заметки (frontmatter + links + lint) | `vault_note_profile` | Не три отдельных запроса |
| Проверить заметку перед коммитом | `vault_lint(target=...)` | Не `vault_stats` |
| Проверить весь волт после batch-правок | `vault_lint` + `vault_broken_links` + `vault_duplicate_links` | Не Grep — медленно и неполно |
| Запрос «как у меня устроена эта тема?» | `/vault-rag <вопрос>` (он сам разрулит L1/L2) | Не дёргать MCP-tools по одному |

---

## Связь скиллов и MCP-tools

MCP-tools выполняют **механические** проверки и индексные запросы. Скиллы используют их как первый шаг, затем добавляют **семантический** анализ через LLM (по чеклисту из [[Audit_checklist]]).

```
/fix-links all   →  vault_broken_links
                    vault_duplicate_links
                    vault_orphans
                    vault_lint
                    + LLM: предлагает исправления

/audit-note X    →  vault_lint(target=X)
                    vault_broken_links
                    vault_duplicate_links
                    + LLM: таксономия, качество ссылок, web search факт-чек

/rename-note     →  vault_backlinks(old_name)
                    vault_broken_links (post-validation)

/add-images      →  vault_backlinks(old_filename)  ← только при смене расширения постера
                    vault_lint(target=note)
                    + LLM: ничего, чистая механика

/remove-gallery-image →  Grep (![file)  ← external-embed detection по filename
                         vault_lint(target=note)  ← post-validation
                         + LLM: ничего, чистая механика
                         (одна multi-choice question на файл с external embeds;
                          в режиме `all` — один вопрос на агрегат всех файлов)

/new-character   →  Glob (existence check)
                    web fetch (MAL/AniList — постер + данные)
                    Read featured_in карточек
                    vault_text_mentions(note=созданный, noteKinds=[character, person])
                                  ← sibling reverse-check, реверс-нога (шаг 7.5b)
                    vault_backlinks(note=созданный)
                                  ← reciprocity backstop, верификация форвард-ноги (шаг 7.5d)
                    vault_lint(target=созданная карточка)

/vault-rag       →  vault_query (L1, если запрос фактологический)
                    vault_semantic_search (L2, если запрос семантический)
                    + LLM: синтез ответа из найденных чанков
```

---

## Governance-документы

Скиллы и MCP-tools опираются на правила из `SYSTEM/`:

| Документ                   | Что регулирует |
|----------------------------|----------------|
| [[Metadata_schema]]        | Обязательные и опциональные поля frontmatter по `note_kind` |
| `enums.yaml`               | Машинно-читаемые множества значений enum-полей. Единственный источник истины. |
| [[Tag_taxonomy]]           | Каноничный набор тегов, категории, обязательные теги по `note_kind` |
| [[Linking_guidelines]]     | Правила WikiLinks, обязательные ссылки по `note_kind`, конвенция «WikiLinks на персонажей — только в одной секции тайтла» |
| [[Naming_conventions]]     | Формат имён файлов (`PascalCase_With_Underscores`, только латиница) |
| [[Vault_architecture]]     | Структура папок и связь с `note_kind` |
| [[Audit_checklist]]        | Единый чеклист для всех аудит-скиллов |

При обновлении правил аудита — менять **только `Audit_checklist`**, скиллы подхватят автоматически.

---

## Как обновлять этот файл

- При появлении нового скилла или MCP-tool'а — добавить строку в соответствующую таблицу.
- При эмпирическом открытии возможности tool'а, которой нет в его описании — записать в секцию «Эмпирические знания» соответствующего MCP-сервера.
- При закреплении конвенции выбора инструмента (например, «для X всегда vault_backlinks, не Grep») — добавить строку в «Когда какой инструмент выбирать».
- Не дублировать содержимое `Audit_checklist`, `Metadata_schema` и других governance-документов. Этот файл — про **инструменты**, а не про правила волта.
