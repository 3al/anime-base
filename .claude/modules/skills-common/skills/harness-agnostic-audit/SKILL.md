---
name: harness-agnostic-audit
description: >
  Audit and rewrite harness-specific tool references in vault skills and governance docs
  so they work in both Claude Code and Opencode. Scans .claude/skills/*/SKILL.md
  (non-managed), SYSTEM/*.md, and CLAUDE.md for CC-only procedural patterns
  (`mcp__X__Y`, `AskUserQuestion`, `WebFetch`, `TaskCreate`, `subagent_type`, ...)
  and proposes harness-agnostic rewrites with per-file confirmation. Use when the
  user says /harness-agnostic-audit, "проверь скиллы на портативность",
  "адаптируй скиллы под Opencode", "сделай скиллы кросс-харнес",
  "harness audit", or wants to make a vault work in both Claude Code and Opencode.
argument-hint: "[<path_or_glob>]"
disable-model-invocation: false
model: opus
---

# /harness-agnostic-audit — Аудит портативности скиллов между harness'ами

Приводит скиллы и governance-документы волта к **harness-agnostic** виду, чтобы они одинаково работали в Claude Code и Opencode.

**Зачем это нужно.** Два harness'а имеют разные имена встроенных tools (`Read` vs `read`, `AskUserQuestion` vs `question`, `WebFetch` vs `webfetch`) и принципиально разные форматы вызова MCP tools (`mcp__<server>__<tool>` в CC vs `<server>_<tool>` в Opencode). Когда SKILL.md инструктирует модель procedural-формой («вызови `mcp__vault-index__vault_query(...)`»), Opencode-сессия с GLM/Qwen/DeepSeek падает — такого tool у неё нет. Casual references («через Read tool») модель смаппит сама, hard gap только в procedural-командах.

**Канонический reference правил** — `docs/Vault_Bootstrap_Architecture.md § Конвенция формата skills → Body content`. Скилл воспроизводит правила здесь для self-contained работы, но при расхождении — Architecture.md является источником истины.

## Аргумент

`$ARGUMENTS` (опционально):
- Пусто — полный аудит волта (default).
- Имя файла или путь — аудит одного файла (например, `/harness-agnostic-audit MUSHROOM/Some_Note.md` — хотя content-заметки обычно не содержат tool refs).
- Glob-паттерн — аудит подмножества (например, `/harness-agnostic-audit .claude/skills/new-*`).

## Scope

**Сканируется:**
- `.claude/skills/<name>/SKILL.md` — **только если в директории НЕТ `.managed` маркера**. Managed-копии принадлежат фреймворку, юзер их править не должен; следующий /init-vault перетрёт.
- `SYSTEM/*.md` — governance-документы (Metadata_schema, Linking_guidelines, Audit_checklist, Tag_taxonomy, Vault_architecture, Naming_conventions, RAG_Schema и любые другие).
- `CLAUDE.md` — vault-level config.

**НЕ сканируется (out of scope):**
- `.claude/modules/` — это source-копии фреймворковых модулей.
- `.obsidian/` — конфиг Obsidian.
- `attachments/` — бинарные вложения.
- Content-папки (`MUSHROOM/`, `LOCATION/`, `OBSERVATION/`, `COOKING/`, `GUIDE/`, `CONCEPTS/`, `RAG/` и пользовательские) — обычно не содержат tool refs. Если юзер явно передал содержимое как `$ARGUMENTS` — обработать.
- Frontmatter скиллов — CC-only поля (`argument-hint`, `model`, `disable-model-invocation`) Opencode тихо игнорирует. Не трогаем.

## Алгоритм

### Этап 1. Discovery

**1.1.** Собрать список целевых файлов:

```
files = []
# SKILL.md (non-managed)
для каждой <vault>/.claude/skills/<name>/:
    если в директории НЕТ файла .managed:
        files += <vault>/.claude/skills/<name>/SKILL.md
# Governance
files += все <vault>/SYSTEM/*.md
# Vault config
files += <vault>/CLAUDE.md (если существует)
```

Если задан `$ARGUMENTS` — заменить весь discovery на один путь / glob.

**1.2.** Сообщить пользователю сводно: «Сканирую N файлов: X скиллов (non-managed), Y SYSTEM/, CLAUDE.md».

### Этап 2. Pattern scan

Греп каждого файла на полный набор CC-only patterns (список ниже §Pattern catalog). Собрать структуру:

```
hits_by_file = {
  "<path>": [
    { line: 42, pattern: "mcp__", matched_text: "mcp__vault-index__vault_query(...)", context: [...] },
    { line: 56, pattern: "AskUserQuestion", matched_text: "через AskUserQuestion", context: [...] },
    ...
  ],
  ...
}
```

Контекст — 2 строки до и после хита для понимания смысла.

**2.1.** Если ни одного хита — сообщить «Все файлы harness-agnostic. Изменений не требуется.» — выйти.

**2.2.** Если хиты есть — суммарный отчёт перед итерацией:
- Список файлов с числом хитов в каждом.
- Топ паттернов (сколько `mcp__`, сколько `AskUserQuestion`, etc.).

### Этап 3. Per-file confirmation loop

Для каждого файла из `hits_by_file` (в детерминированном порядке: сначала SKILL.md, потом SYSTEM/, потом CLAUDE.md):

**3.1.** Прочитать файл целиком (Read).

**3.2.** Для каждого хита в файле — собрать **предлагаемый rewrite** по правилам §Pattern catalog. Не применять механически: смотри на контекст и выбирай естественную формулировку:

- В procedural call (`mcp__X__Y(args)`) с args — R1 («<server> MCP, tool `<tool>(args)`»).
- В упоминании без args (`mcp__X__Y` mention) — R2 («<server> MCP `<tool>`»).
- В wildcard (`mcp__X__*`) — переписать в «MCP tools сервера `<server>`».
- В imperative-инструкции «через AskUserQuestion …» — R3.
- Если CC-имя используется как **термин в документации о паттернах** (например, в самой этой Architecture.md таблице правил, где паттерн упоминается именно как «то что мы переписываем») — **не трогать** (false positive). Сигнал — фраза рядом с матчем типа «❌», «before/after», «не использовать», «избегать», «вместо», «pattern», «пример CC-only».

**3.3.** Показать пользователю **per-file diff bundle** через структурированный multi-choice вопрос:

```
Файл: <path>
Хитов: N

Изменения:
1. Строка 42: `mcp__vault-index__vault_query(...)` → vault-index MCP, `vault_query(...)`
2. Строка 56: «через AskUserQuestion спросить» → «структурированным multi-choice вопросом спросить»
...

Применить?
[A] Применить все
[B] Применить выборочно (укажу номера для пропуска)
[C] Пропустить весь файл (правлю вручную / неактуально)
[D] Прервать аудит
```

Использовать blok multi-choice вопрос. Для опции B — задать второй вопрос с multi-select списком хитов для пропуска.

**3.4.** На основе ответа:
- **A (применить все)** — применить каждый хит через Edit (старая строка → новая). После всех применений к файлу — пометить «N изменений применено».
- **B (выборочно)** — применить только подмножество, пропущенные хиты пометить как «skipped by user».
- **C (пропустить файл)** — отметить файл «skipped», перейти к следующему.
- **D (прервать)** — выйти из цикла, перейти к §Summary с partial-state.

**3.5.** Применение Edit'а:
- old_string = строка с матчем + достаточный контекст для уникальности (обычно достаточно 1 строки, но если строка повторяется — взять 2-3 строки).
- new_string = переписанная версия.
- Если Edit упал (old_string не найден / не уникален) — записать как «edit_failed», показать юзеру для ручной правки.

### Этап 4. Opencode wrapper generation

**Зачем:** в Opencode skill tool принимает только `name` — args в скилл доходят через conversation context. Slash-вызов `/<skill-name> <args>` в Opencode по умолчанию **пассивно загружает** SKILL.md как spec (модель acknowledges, не действует). Чтобы slash-команды работали активно, нужен тонкий wrapper в `.opencode/commands/<name>.md`, который явно инструктирует модель вызвать skill и выполнить инструкции.

**4.1. Безусловная генерация.** Wrappers создаются для **всех** скиллов волта, **независимо** от того детектится ли Opencode прямо сейчас. Принцип волта — harness-agnostic by default: tools должны работать в любом harness без отложенной настройки. Wrappers — это derived артефакты, которые CC игнорирует (читает только `.claude/skills/`), а Opencode читает (`.opencode/commands/`). Их безусловное присутствие = «открыл волт в Opencode завтра → всё работает сразу, без ручных шагов».

Контекст для summary: если опционально хочется отразить состояние, можно отметить признаки Opencode-targeted setup (для информации, не для гейтинга):
- `<vault>/opencode.json` существует
- `<vault>/.opencode/` директория существует (после этого этапа — гарантированно да)
- `<vault>/.claude/vault-manifest.yaml::modules` содержит `harness-opencode`

**4.2. Discover skills needing wrappers.** Сканировать `<vault>/.claude/skills/<name>/` — для каждого скилла (managed и non-managed одинаково):

- Если wrapper `.opencode/commands/<name>.md` отсутствует → нужен новый.
- Если существует → перегенерировать содержимое из текущего SKILL.md frontmatter, сравнить. Если diff — нужен update. Если идентично — skip.

Wrappers — derived artifacts, юзерская кастомизация в них не предусмотрена.

**4.3. Wrapper template.** Из SKILL.md frontmatter извлечь `name` и **полный `description` целиком** (verbatim — нужно для корректного implicit-matching и autocomplete в Opencode; расхождение между SKILL.md и wrapper description ломает фуззи-резолв). Сгенерировать:

```yaml
---
description: <SKILL.md description verbatim, ≤1024 chars per Opencode spec>
---
Invoke the `<skill-name>` skill via the skill tool NOW.

User's arguments: $ARGUMENTS

Execute the skill's instructions IMMEDIATELY using the arguments above. Do not just acknowledge — perform the actions and report the result.
```

**Почему императивный язык:** Opencode при slash-вызове skill'а одновременно инжектит SKILL.md в user message И оставляет skill tool exposed. На слабых моделях (GLM 5.1 / Qwen / DeepSeek) это путает — модель воспринимает inject как passive spec. Wrapper текст «NOW», «IMMEDIATELY», «do not just acknowledge» — explicit signal что нужно действовать. Бенчмаркнуто на GLM 5.1 эмпирически (probes S1/S2/NL, 2026-05-27). Upstream-issue: [sst/opencode#26185](https://github.com/sst/opencode/issues/26185).

**Не дублировать SKILL.md инструкции в wrapper.** Wrapper тонкий — 5-7 строк. Инструкции живут в SKILL.md, wrapper только триггерит их вызов с args. Дублирование = 2× контекст + риск drift между копиями.

**4.4. Batch confirmation.** Показать пользователю сводный список:

```
Opencode wrappers — нужны изменения:
- .opencode/commands/verify.md (new)
- .opencode/commands/new-mushroom.md (new)
- .opencode/commands/audit-note.md (update — description изменилась после rewrite)
- ...

[A] Создать/обновить все
[B] Показать template для проверки
[C] Пропустить
```

Variant [B] — показать пример полного wrapper'а перед apply.

**4.5. Apply.** Создать `.opencode/commands/` директорию если её нет. Записать wrappers через Write. Накопить counts (created/updated/unchanged) для summary.

**Реализация:** общий helper `core/lib/opencode_wrappers.mjs::buildWrapperContent(skillName, skillDescription) → string` (доступен после Phase 1B `harness-opencode` модуль; до этого — inline в SKILL.md). Этот же helper использует `harness-opencode/install.mjs` для bulk-генерации на /init-vault и `/add-note-kind` для immediate-генерации при создании нового тематического скилла.

### Этап 5. CLAUDE.md authoring conventions sub-block

**Зачем.** Без durable правила в CLAUDE.md любая ручная правка скилла (или новый скилл, написанный без `/add-note-kind`) снова введёт harness-specific патерны. CLAUDE.md всегда в контексте агента → правило применяется автоматически при создании/редактировании любого `.claude/skills/*/SKILL.md`.

**Безусловная вставка.** Sub-block вставляется **всегда**, не гейтится на detection какого-либо харнеса. Принцип волта — harness-agnostic by default: правило одинаково применимо при работе из Claude Code (где модель должна писать скиллы, работающие и в Opencode) и из Opencode (наоборот). Гейтинг на «текущий харнес» противоречит самой идее.

**5.1. Marker-based idempotency.** В `<vault>/CLAUDE.md` ищется блок между маркерами:

```markdown
<!-- harness-agnostic-conventions:start -->
...
<!-- harness-agnostic-conventions:end -->
```

- Если маркеры есть и контент совпадает с canonical (см. 5.3) → noop, отметить `unchanged` для summary.
- Если маркеры есть, контент дрифтанул (старая версия правила, прежний rewrite skill'а изменил текст) → переписать содержимое между маркерами на текущий canonical. Отметить `updated`.
- Если маркеров нет → вставить блок в конец `CLAUDE.md` (после всех существующих module sub-blocks и user-content). Если файла нет — создать с минимальным содержимым (header + наш sub-block). Отметить `inserted`.

**5.2. Confirmation.** Перед записью показать пользователю diff и спросить через структурированный multi-choice вопрос: «Insert/update harness-agnostic conventions sub-block в CLAUDE.md?». Если файла CLAUDE.md нет — упомянуть что он будет создан. Варианты: `[A] Применить`, `[B] Показать diff подробно` (для update — full before/after), `[C] Пропустить этот шаг`.

**5.3. Canonical sub-block content.**

```markdown
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
```

Контент **детерминированный** — `/harness-agnostic-audit` в одинаковом окружении генерирует байт-в-байт идентичный sub-block. Это критично для idempotency: повторный запуск без изменений → `unchanged`. При эволюции содержимого (например, появился R9) — поднимать версию skills-common и в changelog отмечать что блок дрифтнет на новый формат.

**5.4. Edge cases:**
- CLAUDE.md содержит trailing whitespace / non-LF newlines / BOM — preserve как есть, sub-block добавлять/обновлять без затрагивания остального.
- Если CLAUDE.md есть, но блок размещён в неудачном месте (например, посреди другого managed sub-block) — НЕ перемещать, оставить там где найден, обновить контент. Перемещение — отдельная manual op.
- Если в CLAUDE.md уже есть header `## Skills authoring conventions` БЕЗ marker-обёртки (user написал руками) — НЕ затирать, показать warning «manual section detected, consider adding markers to enable auto-management», предложить wrap'нуть в маркеры. По умолчанию — skip, не трогать.

### Этап 6. Summary

После прохода всех файлов (либо по abort) — отчёт:

```
/harness-agnostic-audit — Сводка

Body rewrite:
  Просканировано файлов: N
  Хитов всего: M
  Применено: A
  Пропущено по выбору юзера: B
  Failed Edit (нужна ручная правка): C
  Skipped целиком: D

Opencode wrappers (generated unconditionally — harness-agnostic by default):
  Wrappers created: X
  Wrappers updated: Y
  Wrappers unchanged: Z
  Opencode runtime context: yes (opencode.json present) | not yet (CC-only setup detected, wrappers ready when Opencode starts being used)

CLAUDE.md authoring conventions sub-block:
  Action: inserted | updated | unchanged | skipped (user)

Изменённые файлы (body):
- <path>: N изменений

Созданные/обновлённые wrappers:
- .opencode/commands/<name>.md (new|updated)

Файлы для ручной правки (Edit упал):
- <path>:<line> — <pattern>: <matched_text>
  Причина: <reason>

Следующий шаг: git diff <vault> для ревью изменений.
```

Если применений > 0 — напомнить:
> «Для волта с активной обвязкой `/init-vault` или git-управлением — закоммить изменения, прежде чем продолжать работу.»

## Pattern catalog (canonical правила)

Полная синхронизированная копия из `docs/Vault_Bootstrap_Architecture.md § Body content`:

| # | CC pattern (regex / литерал) | Harness-agnostic replacement |
|---|---|---|
| **R1** | `` `mcp__<server>__<tool>(<args>)` `` (procedural call) | `` <server> MCP, tool `<tool>(<args>)` `` |
| **R2** | `` `mcp__<server>__<tool>` `` (mention без args) | `` <server> MCP `<tool>` `` |
| **R3** | «через AskUserQuestion …» / «через AskUserQuestion спросить» | «структурированным multi-choice вопросом …» |
| **R4** | «AskUserQuestion блок с multi-select» | «блок multi-choice вопросов с multi-select» |
| **R5a** | `WebFetch` (procedural: «через WebFetch», «WebFetch: …») | «через web fetch» / «web fetch: …» (lowercase, generic) |
| **R5b** | `WebSearch` (procedural) | «через web search» / «web search: …» |
| **R6** | `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` / `TaskStop` / `TaskOutput` (procedural) | «через TODO-список» / «обновить TODO-список» |
| **R7** | `subagent_type=Explore` (в инструкции модели на спавн) | «sub-agent типа Explore» |
| **R8** | `$1` / `$2` / `$3` numeric positional placeholders в body (вне frontmatter `argument-hint`) | «первый аргумент» / «второй аргумент» / «третий аргумент» (natural language). **`$ARGUMENTS` оставляем** — universal placeholder, работает в обоих харнесах. |

**Дополнительные CC-only имена** для grep'а (которых нет в Opencode — переписывать в natural language по смыслу):

`NotebookEdit`, `BashOutput`, `KillShell`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `RemoteTrigger`, `SendMessage`, `TeamCreate`, `TeamDelete`, `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree`, `ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`, `Monitor`, `PushNotification`.

Для каждого — смотри контекст: если это procedural call — переписать в intent-language («запустить sub-agent в worktree» вместо «вызови EnterWorktree»). Если casual mention — оставить.

**НЕ переписывать:**
- Casual references к универсальным tools: `Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`, `WebFetch` (в casual mention), `WebSearch` (в casual mention). У всех есть lowercase-аналог в Opencode, модель смаппит сама. Hard gap только когда промпт инструктирует **эмитить** вызов с конкретным именем.
- Имена `Skill` tool, `Agent`/`Task` tool в casual mention — оба harness имеют аналог.
- Frontmatter поля (CC-only `argument-hint`, `model:`, `disable-model-invocation:`) — Opencode игнорирует.
- **`$ARGUMENTS`** — universal placeholder, оба харнеса понимают одинаково.
- `$1` / `$2` **внутри блока `## Пример` / `## Examples`** — это иллюстрация вызова с CLI-аргументами, не процедурный placeholder. Оставлять как есть.

**Тонкости R8 ($1/$2 в Opencode):**

В Opencode при slash-вызове происходит **наивная substitution** `$1`/`$2`/`$3` ВЕЗДЕ в тексте SKILL.md, включая logic-ветки. Это разрушает фразы типа «Если `$1` не указан» → «Если `<actual_arg_value>` не указан» (логика инвертируется). Поэтому даже casual-упоминания `$1` в body — мина. Переписываем все вхождения за пределами frontmatter и блоков-примеров.

Frontmatter `argument-hint: "$1 [quality: verified|draft]"` — оставляем как есть (Opencode ignores frontmatter).

## False-positive heuristics

Не переписывай хит если рядом (в пределах 3 строк):

- Markdown-блок «❌ → ✅» / «before / after» / «до / после» — это документация о самих паттернах.
- Слова «не использовать», «избегать», «вместо», «pattern», «пример CC-only», «❌» — паттерн упомянут именно как antipattern для замены.
- Строка целиком в кавычках с маркером кода как пример.
- Строка в таблице правил миграции (например, в Architecture.md «Body content» секции).

В сомнительных случаях — задать вопрос юзеру: «Строка <N>: похоже на документацию о паттерне, переписывать?». При значимой неопределённости показывать чаще, чем реже — стоимость false-positive выше стоимости лишнего вопроса.

## КРИТИЧНО

1. **Не применять без подтверждения.** Никаких silent rewrites. Каждый файл с хитами → структурированный вопрос юзеру.

2. **Idempotency.** Повторный запуск на уже-переписанном волте должен сообщать «всё чисто, изменений не требуется» — без false detection своих же замен.

3. **Не трогать managed скиллы.** Файл `.managed` в директории скилла — сигнал «этим управляет фреймворк». Skip silently, не упоминать в summary как «пропущенный» (это default).

4. **Не редактировать frontmatter.** CC-only поля валидны в обоих харнесах. Если в body найден pattern в YAML-блоке (редкий случай) — переписывать только если это явный procedural call в multi-line string.

5. **Контекст-aware rewrites.** R1 (`mcp__X__Y(args)`) не тупо substring-replace. Смотри окружающую прозу:
   - В пунктом списке «1. Запроси stats — `mcp__vault-semantic__vault_semantic_stats()`» → «1. Запроси stats — vault-semantic MCP, tool `vault_semantic_stats()`»
   - В таблице — может быть короче без «tool»: «| key | vault-index MCP, `vault_query(...)` |»
   - В кодовом блоке — комментарий-prefix `# vault-semantic MCP` + бар имя без префикса.

6. **Не применять Edit с не-уникальным old_string.** Если строка повторяется в файле — расширь old_string на 2-3 строки контекста для уникальности. При невозможности уникализации — пометь как `edit_failed`, юзер правит руками.

7. **Audit_checklist.md обращай внимание.** Этот файл — нормативный (агенты в волте читают как guideline). Переписывание там влияет на behaviour всех скиллов. Если есть сомнения по конкретной строке — спроси юзера явно.

8. **Не превращай в линтер.** Скилл — для разовой миграции или периодических аудитов. Не run-on-save, не pre-commit hook. Если юзер хочет регулярную проверку — это отдельный сценарий (CronCreate / git hook), не часть этого скилла.

## Пример сценария

```
$ /harness-agnostic-audit

Сканирую 14 файлов: 9 скиллов (non-managed), 4 SYSTEM/, CLAUDE.md.

Найдено хитов: 36 в 7 файлах.

Топ паттернов:
- mcp__: 14
- AskUserQuestion: 11
- WebFetch: 6
- WebSearch: 4
- TaskCreate: 1

Файлы (по убыванию хитов):
- .claude/skills/vault-rag/SKILL.md: 10
- .claude/skills/new-mushroom/SKILL.md: 8
- .claude/skills/add-found-species/SKILL.md: 5
- .claude/skills/audit-images/SKILL.md: 4
- .claude/skills/new-observation/SKILL.md: 4
- SYSTEM/Audit_checklist.md: 3
- CLAUDE.md: 2

Начинаю per-file confirmation. Прервать в любой момент — D.

---

[file 1 of 7] .claude/skills/vault-rag/SKILL.md — 10 изменений

  1. line 34: «ни один `mcp__vault-semantic__*` tool недоступен»
     → «ни один MCP tool сервера `vault-semantic` недоступен»

  2. line 42: «`mcp__vault-semantic__vault_semantic_stats()`»
     → «vault-semantic MCP, tool `vault_semantic_stats()`»

  ...

  [A] Применить все
  [B] Применить выборочно
  [C] Пропустить файл
  [D] Прервать

> A

  Применено: 10/10. Готово.

---

[file 2 of 7] ...
```

## Известные ограничения

- **Не покрывает** новый класс паттернов, появившихся после написания скилла. Если в SKILL.md появляется обращение к новому CC-only tool, не указанному в Pattern catalog — скилл его не поймает. Решение: при появлении нового pattern — обновить таблицу в Architecture.md (canonical) и в этом SKILL.md (зеркало).

- **LLM-driven** — нет статической SQL-grammar для замен. Качество rewrites зависит от модели. На GLM 5.1 / Qwen / DeepSeek результат может потребовать ручной правки в нескольких файлах. На Sonnet/Opus — обычно clean.

- **Cross-file consistency не гарантируется** — каждый файл обрабатывается изолированно. Если в волте есть единый стиль формулировок (например, везде «vault-index MCP» vs «через vault-index»), скилл не нормализует — он применяет canonical R1 form. Стилистическую унификацию делай отдельным `/audit-note` проходом по конкретным файлам.
