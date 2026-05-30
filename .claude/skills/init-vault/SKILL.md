---
name: init-vault
description: >
  Bootstrap a new Obsidian vault: read manifest, resolve module dependencies, run
  install/status handlers, register MCP servers, patch CLAUDE.md. Use when the user
  says /init-vault, "разверни инфру в новом волте", "init vault", "bootstrap vault",
  or runs the skill on a freshly-copied portable bundle. See SYSTEM/Vault_Bootstrap_Architecture.md.
argument-hint: "[--check] [--update] [--module <name>]"
disable-model-invocation: false
---

# /init-vault — Развёртывание инфраструктуры волта

Точка входа в bootstrap-фреймворк. Читает `.claude/vault-manifest.yaml`, определяет порядок установки модулей по зависимостям, запускает их handler'ы, агрегирует результаты.

**Архитектура и контракты:** `SYSTEM/Vault_Bootstrap_Architecture.md`. Читай этот документ при любых сомнениях о форматах и протоколе.

## Аргументы

- `--check` — только status-проверка, без установки. Выводит отчёт «что установлено / что отсутствует / что устарело».
- `--module <name>` — установить/проверить только указанный модуль (плюс его зависимости).
- `--update` — при обнаружении drift между волтом и bootstrap-репо (Шаг 1.5) **авто-запустить `setup.mjs`** из `bootstrap_repo` (берётся из marker), повторить drift-check и продолжить. Без флага drift → STOP с просьбой запустить setup.mjs вручную. См. Шаг 1.5 `action: "drift"`.
- Без аргументов — полный run по манифесту.

## Что делать

### Шаг 1. Verify environment

1. Проверить, что текущая директория содержит `.obsidian/`. Нет → отказать: «Это не Obsidian-волт. См. `SYSTEM/Porting_Guide.md`».
2. Проверить, что `.claude/modules/` существует. Нет → отказать: «Portable bundle не скопирован. См. `SYSTEM/Porting_Guide.md`».
3. Проверить, что Node.js доступен (`node --version`). Если версия <20 — warning, но продолжить.

### Шаг 1.5. Bootstrap source drift check (D19)

Перед загрузкой манифеста — проверить, что локальные копии модулей в `.claude/modules/` совпадают по версиям с bootstrap-репо, из которого они были материализованы.

Маркер: `<vault>/.claude/.bootstrap-source.json` (создаётся `setup.mjs` при materialize, gitignored). Содержит `bootstrap_repo` (абс. путь), `bootstrap_repo_commit` (HEAD short SHA), `materialized_at` (ISO timestamp), `modules` (map имя→версия).

Запустить:
```bash
node .claude/modules/core/lib/bootstrap_source.mjs --vault-root "<абс. путь к волту>"
```

Stdout — JSON `{action, ...}`. По полю `action`:

#### `action: "no_marker"`
Волт материализовался до D19 или маркер удалён. **Не блокирует.** Вывести INFO:
```
ℹ Bootstrap source marker not found (.claude/.bootstrap-source.json).
  Drift check unavailable. To enable it, re-run setup.mjs from the
  bootstrap repo:  node <bootstrap-repo>/setup.mjs "<vault>"
```
Продолжать с Шага 2.

#### `action: "repo_inaccessible"`
Маркер есть, но `bootstrap_repo` (путь из маркера) не существует или не содержит `modules/`. **Не блокирует** — bootstrap мог переехать. WARN:
```
⚠ Bootstrap repo not accessible at <marker.bootstrap_repo>.
  Drift check skipped. If the framework moved/was updated, re-run
  setup.mjs from its new location to refresh the marker.
```
Продолжать с Шага 2.

#### `action: "malformed_marker"`
JSON marker битый. **Не блокирует**, но WARN с `error` из stdout. Предложить запустить `setup.mjs` для перезаписи. Продолжать.

#### `action: "ok"`
Все версии совпадают. INFO одной строкой:
```
✓ Bootstrap source: <bootstrap_repo> @ <marker_commit> — all modules up-to-date.
```
Продолжать с Шага 2.

#### `action: "drift"` — **STOP** (без `--update`) или **AUTO-SYNC** (с `--update`)

Хотя бы один модуль расходится: версия изменилась, удалён из bootstrap, или добавлен новый. Продолжать со stale code породит ошибки уровня D7/D11 (как было в Phase 6.1 closure).

В обоих режимах сначала показать пользователю таблицу drift из `drift[]` массива:

```
⚠ Framework drift detected: vault modules out of sync with bootstrap repo.

  Module                Local       Bootstrap    Change
  ──────────────────────────────────────────────────────────────
  core                  0.6.1   →   0.7.0        version_changed
  harness-claude-code   0.3.0   →   0.3.1        version_changed
  harness-opencode      (—)     →   0.1.0        added_to_bootstrap
  old-module            1.0.0   →   (—)          removed_from_bootstrap

  Bootstrap repo:   <bootstrap_repo>
  Marker commit:    <marker_commit>
  Current commit:   <current_commit>
```

Колонка «Change» — значение `kind` из drift entry (`version_changed` / `added_to_bootstrap` / `removed_from_bootstrap`). Если `local` или `bootstrap` равны `null` — отображать как `(—)`.

**Дальше — зависит от флага:**

##### Без `--update` (default): STOP

Вывести инструкцию и прервать run сразу же (до status check). Никаких install/status шагов после этого не запускать.

```
  To sync, re-materialize from bootstrap:
    node <bootstrap_repo>/setup.mjs "<vault_root>"

  Then re-run /init-vault.

  Or rerun with auto-sync:
    /init-vault --update
```

##### С `--update`: AUTO-SYNC

1. Сообщить о намерении:
   ```
   → --update flag set, running setup.mjs to sync vault from bootstrap...
   ```

2. Запустить `setup.mjs` из `bootstrap_repo` поля marker'а:
   ```bash
   node "<bootstrap_repo>/setup.mjs" "<vault_root>"
   ```
   Использовать **именно тот** `bootstrap_repo` путь, что в marker'е (`stdout.bootstrap_repo`) — не угадывать локацию из текущего рабочего пути. Дождаться exit code.

3. **Если `setup.mjs` упал** (exit ≠ 0) — STOP, вывести stderr и прервать. Не пытаться чинить сам — это пользовательская инвестиция в починку фреймворка (битый git checkout, отсутствующие файлы и т.п.). Показать команду для ручного запуска и предложить попробовать ещё раз с `--update` после починки.

4. **Если `setup.mjs` отработал** — повторить drift check:
   ```bash
   node .claude/modules/core/lib/bootstrap_source.mjs --vault-root "<vault_root>"
   ```

5. По результату повторного check'а:
   - `action: "ok"` — INFO `✓ Auto-sync complete — vault re-materialized from <bootstrap_repo> @ <new_marker_commit>.`, продолжать с Шага 2.
   - `action: "drift"` снова — **STOP** со stronger error: «setup.mjs ran but drift persists — фреймворк в нестабильном состоянии. Detailed drift table: …». Не зацикливаться (один auto-attempt).
   - `action: "repo_inaccessible" | "malformed_marker"` после успешного setup.mjs — bug в setup.mjs (он должен был перезаписать marker). STOP с error для диагностики.
   - `action: "no_marker"` после успешного setup.mjs — то же, bug. STOP.

**Edge case:** если `bootstrap_repo` путь из marker недоступен (хотя `bootstrap_source.mjs` для этого случая обычно отдаёт `repo_inaccessible`, а не `drift`) — STOP с error «Cannot auto-sync: bootstrap repo not at expected path. Re-run setup.mjs from its current location manually.»

### Шаг 2. Load manifest

1. Прочитать `.claude/vault-manifest.yaml`.
2. Распарсить визуально (это простой YAML — список `modules:`, поле `language:`, секция `config:`).
3. Если файла нет — перейти в **Интерактивный режим** (см. ниже).

### Шаг 3. Build dependency graph

1. Для каждого модуля из манифеста — прочитать `.claude/modules/<name>/module.yaml`.
2. Извлечь `requires: [...]`.
3. **Auto-pull**: если модуль в `requires` отсутствует в манифесте — добавить с уведомлением пользователю.
4. **Cycle detection**: если граф циклический — ошибка, остановиться.
5. **Topological sort** — модуль ставится после всех своих зависимостей.
6. **Harness — последними (КРИТИЧНО).** После топосорта применить вторичное правило: **harness-модули** (те, чья роль — регистрировать MCP-серверы, объявленные *другими* модулями; по конвенции названы `harness-*` и в `module.yaml` имеют `provides.mcp_server: null`) обязаны идти **после всех** модулей, объявляющих `provides.mcp_server: {name: …}` (vault-index, vault-semantic и т.п.). Причина: harness читает per-vault `.installed` маркеры провайдеров и пропускает регистрацию (`module_not_installed`) для тех, что ещё не поставлены. Если harness отработает раньше провайдера в том же проходе — MCP-сервер останется незарегистрированным до повторного прогона harness. Формально harness `requires` только `core`, поэтому топосорт сам по себе их в конец не двигает — это правило надо применить явно.

### Шаг 4. Status check (всегда)

Для каждого модуля по порядку:
1. Прочитать `module.yaml`, получить путь к `ops/status.mjs`.
2. Запустить через Bash: `echo '<INPUT_JSON>' | node .claude/modules/<name>/ops/status.mjs`.
3. INPUT_JSON формируется по контракту из `Vault_Bootstrap_Architecture.md` — раздел «Общий ввод/вывод»:
   ```json
   {
     "vault_root": "<абсолютный путь к корню волта>",
     "module_name": "<имя модуля>",
     "module_dir": "<абсолютный путь к .claude/modules/<name>>",
     "config": <значения из manifest.config.<name>, или {}>,
     "language": "<из манифеста>",
     "harness": ["claude-code"],
     "platform": "<win32|darwin|linux>"
   }
   ```
   `install_scope` и `shared_module_dir` передавать **не нужно** — status-handler сам читает scope из `module.yaml` и резолвит shared path через `core/lib/paths.mjs::resolveSharedToolsHome()`. Если хочется явно override'нуть scope (для тестов с изолированным `VAULT_TOOLS_HOME`) — input-поля по-прежнему принимаются и имеют приоритет над манифестом.
4. Распарсить stdout как JSON. Собрать `module_status` каждого.

### Шаг 5. Plan

Сформировать план действий:
- Модули со статусом `installed` и совпадающей версией → пропустить.
- `missing` → install.
- `outdated` → update (Phase 1: warning, без миграционной логики — просто запустить install заново).
- `missing_prerequisite` → ошибка, дальше не идти.

Если запущен с `--check` — на этом шаге остановиться, вывести отчёт.

### Шаг 6. Execute

#### 6.0. Pre-install для shared-модулей (только если `install_scope: shared`)

См. `docs/Shared_Install_Architecture.md` (Phase 4.5 spec). Heavy-артефакты (venv, model cache, source-копия) живут в `$VAULT_TOOLS_HOME/<name>/` — общем на машину, один на всех волтов. Перед install handler'ом нужно подготовить shared root:

```bash
node .claude/modules/core/lib/shared_install.mjs \
  --bootstrap-module-dir "<abs>/.claude/modules/<name>" \
  --module-name "<name>" \
  --self-vault-root "<abs_vault_root>"
```

Параметры:
- `--bootstrap-module-dir` — абсолютный путь к директории модуля в волте (`<vault>/.claude/modules/<name>/`). Источник source-копии и точка для `source_sha`.
- `--module-name` — имя модуля. CLI сам резолвит `shared_module_dir = $VAULT_TOOLS_HOME/<name>` через `core/lib/paths.mjs::resolveSharedToolsHome()`. Никаких хардкодов в манифестах.
- `--self-vault-root` — **D20 (v0.7.1+)** абсолютный путь к волту, который инициирует install. Передавай **всегда** — без этого in-session shared upgrade для своего же волта будет вечно заблокирован собственными MCP-процессами этой CC сессии. Consumers с `project == self_vault_root` помечаются как `self_session` и не блокируют destructive ops. Live-процессы при этом остаются — atomicSwap (rename-aside) гарантирует, что текущий shim переживёт swap, обновлённые байты подхватятся при следующем CC restart.

Альтернативно можно явно задать `--shared-module-dir <abs>` (для тестов с изолированным `VAULT_TOOLS_HOME`).

Stdout — JSON с полями `{action, source_copied, venv_dropped, source_sha, version, shared_module_dir}`. `action` ∈ `first_install | version_bump | refresh_source | noop | aborted_active_consumers`. На stderr — JSON ошибки если что-то сломалось (exit code 1).

**Phase 6.1 (D7+D18) — обработка `aborted_active_consumers`:**

Если возвращается `action: "aborted_active_consumers"` (exit code 3), `shared_install.mjs` обнаружил **активных** MCP-консьюмеров этого shared root и **ничего не трогал** (защита от corrupted venv state).

Stdout содержит:
- `active_consumers: [{config_file, project, server_name, ref_path, is_self: false, probe, live_pids}, …]` — **зарегистрированные + реально живые** (process probe нашёл живые процессы которые держат файлы в shared root) **из других волтов**. Это то что **блокирует** install. Сюда **НЕ** попадают consumers текущего волта (см. `--self-vault-root` ниже).
- `self_session_consumers: [{...is_self: true, probe, live_pids}, …]` — **D20** consumers с `project == self_vault_root`. Зарегистрированы и обычно живы (мы их сами и спавнили), но **не блокируют** — atomicSwap переживёт live shim. Информационно для диагностики.
- `stale_consumers: [...]` — зарегистрированы в ~/.claude.json, но **процессов нет**. Не блокирует, информационно для cleanup.
- `live_processes: [{pid, cmdline}]` — конкретные процессы что нашёл probe. Помогает identify какие именно окна CC надо закрыть.
- `probed: bool` — если `false`, process probe не сработал (нет powershell/ps), все registered трактуются как active fail-safe.
- `planned_action: 'version_bump' | 'refresh_source'` — что хотело сделать.

В этом случае:
1. **НЕ запускай install handler модуля** — он не сможет работать с непросвижененным shared root.
2. Пометь модуль как `failed: blocked_by_active_consumers` в финальном отчёте.
3. Покажи пользователю явный actionable error:
   ```
   ⚠ Module <name>: shared-install upgrade blocked by live processes.

   Active consumers (live process holds files in shared root):
     • Project <project> → server "<server_name>" (PIDs: <live_pids>)

   Live processes detected:
     • PID <pid>: <cmdline truncated to 80 chars>

   To upgrade: close the Claude Code windows for those projects,
   then rerun:
     /init-vault --module <name>

   <если stale_consumers не пуст:>
   Note: also found stale registrations in ~/.claude.json (no live process):
     • Project <project> → server "<server_name>"
   They don't block this install but you may want to manually clean
   ~/.claude.json::projects[<project>].mcpServers entries if those vaults
   no longer exist.

   If you want to install other modules and defer this one, the rest of
   the manifest can proceed — just skip this module from the current run.
   ```
4. Спроси пользователя выбор: (a) abort whole run, (b) skip this module, продолжай остальные. Это эквивалентно текущему «Skip module» UI option.

**После успешного pre-install** прокинь в install handler:
- `install_scope: "shared"`
- `shared_module_dir` — значение из stdout
- `source_sha` — значение из stdout
- `version` — значение из stdout

#### 6.1. Run install handler

Для каждого модуля, требующего действия, по порядку:
1. Запустить `ops/install.mjs` тем же способом, что status (расширенный INPUT_JSON для shared-модулей включает поля из 6.0).
2. Распарсить ответ. Если `status: error` — остановить дальнейшие установки, вывести отчёт об ошибке.
3. Если `status: needs_torch_decision` (см. 6.1.1) — handler не поставил модуль и ждёт решения юзера.
4. Накопить `actions`, `warnings`, `next_steps`.

**6.1-net. Финальный harness-проход (safety net).** Шаг 3.6 уже ставит harness последними, поэтому штатно повторный прогон не нужен. Но если по какой-то причине **harness-модуль вернул warning `module_not_installed`** (он отработал раньше, чем провайдер этого MCP-сервера был поставлен в том же проходе) — после завершения всех установок **повторно запусти install этого harness-модуля один раз**. На втором проходе провайдер уже имеет `.installed` маркер → регистрация проходит. Это гарантирует регистрацию MCP даже если порядок почему-то нарушился; без него `module_not_installed` остаётся неразрешённым и MCP-сервер не зарегистрирован. Не зацикливаться (один повтор).

#### 6.1.1 Обработка `needs_torch_decision` (vault-semantic v0.4.0+)

`vault-semantic` install handler возвращает `status: needs_torch_decision` если:
- `config.vault-semantic.device == 'auto'` (default), И
- nvidia-smi probe нашёл NVIDIA GPU, И
- в `.claude/modules/vault-semantic/.installed` ещё нет `torch_variant` (первый install с GPU).

Stdout содержит блок `decision`:
```json
{
  "kind": "torch_variant",
  "gpu_detected": ["NVIDIA GeForce RTX 3070 Laptop GPU"],
  "vault_note_count": 77,
  "shared_torch_variant": "cuda_cu126",
  "recommended_variant": "cuda_cu126",
  "recommendation_reason": "shared venv already uses cuda_cu126 — picking the same avoids a torch swap that affects other vaults",
  "options": {
    "cpu":  { "torch_variant": "cpu",         "torch_wheel_mb": 200,  "venv_total_gb": 1.2, "est_first_reindex_min": 31, "sec_per_note": 23.4 },
    "cuda": { "torch_variant": "cuda_cu126",  "torch_wheel_mb": 2600, "venv_total_gb": 3.5, "est_first_reindex_min": 6,  "sec_per_note": 4.5 }
  },
  "measured_on": "RTX 3070 Laptop / driver 591.74 / Python 3.14 / cp314+cu126",
  "note": "Estimate based on measured reindex on RTX 3070 Laptop / cp314+cu126. Real speedup varies..."
}
```

**Поля v0.4.3+:**
- `shared_torch_variant` — variant, на котором стоит shared venv прямо сейчас (`null` если первая установка на машине).
- `recommended_variant` — `"cpu"` или `"cuda_cu126"`. **Считается серверсайдом** с учётом shared state, не выводи свою эвристику по размеру волта. Логика: если shared уже зафиксирован — рекомендация та же (избежать swap, который ударит по другим волтам); иначе для волтов > 25 заметок — CUDA, иначе — CPU.
- `recommendation_reason` — короткая фраза-объяснение, показывай юзеру.

**Что делать:**

1. **Показать юзеру конкретный trade-off** структурированным multi-choice вопросом. Сформируй текст из полей `decision`:
   - GPU: `gpu_detected[0]`
   - Размер волта: `vault_note_count` заметок
   - Если `shared_torch_variant` не null — упомянуть: «На машине уже стоит shared venv с `<shared_torch_variant>`».
   - CPU: ~`options.cpu.est_first_reindex_min` мин первичной индексации, диск ~`options.cpu.venv_total_gb` GB (`options.cpu.torch_wheel_mb` MB wheel)
   - CUDA: ~`options.cuda.est_first_reindex_min` мин первичной индексации, диск ~`options.cuda.venv_total_gb` GB (`options.cuda.torch_wheel_mb` MB wheel)
   - Caveat из `note` (estimate based on RTX 3070; faster GPUs hit CPU-bound ceiling sooner; incremental refresh fast в любом варианте — только первый reindex платит full cost).
   - **Recommended-метка** — навешивай на ту опцию, что совпадает с `recommended_variant`. Поясни `recommendation_reason` рядом или ниже опций. Никогда не вычисляй recommended самостоятельно — handler уже учёл shared state, которого у тебя в локальном контексте нет.

2. **После выбора** — записать в манифест `.claude/vault-manifest.yaml`:
   ```yaml
   config:
     vault-semantic:
       device: cuda    # или cpu
   ```
   Если секции `config.vault-semantic` нет — создать. Если есть — добавить/обновить ключ `device`.

3. **Перезапустить install.mjs для этого модуля** с обновлённым `config.device` в INPUT_JSON (не нужен полный /init-vault — достаточно повторить Шаг 6.1 для одного модуля). На втором запуске probe не сработает: handler видит явный `device: cpu|cuda` в manifest и идёт прямой веткой.

4. Накопить `actions` из обоих запусков (probe + install) для итогового отчёта.

**Edge cases:**
- Юзер хочет «потом решить» — Skip module, выведи в `next_steps`: «Установка vault-semantic отложена. Открой `.claude/vault-manifest.yaml`, добавь `config.vault-semantic.device: cpu` или `cuda`, затем запусти `/init-vault --module vault-semantic`».
- Probe сломался (nvidia-smi есть в PATH но wedged) — install сам fall-through на CPU silently. Юзер позже может переопределить через manifest и triggered drift swap.
- Юзер хочет AMD/Intel GPU — пока не поддержано (cu126 only). Выбирай CPU. ROCm/MPS — отдельная фича.

#### 6.1.2 Обработка `needs_shared_torch_swap_consent` (vault-semantic v0.4.1+)

`vault-semantic` install handler возвращает `status: needs_shared_torch_swap_consent` если shared venv (`$VAULT_TOOLS_HOME/vault-semantic/.installed`) уже зафиксировал `torch_variant`, а текущий запрос требует другой. Shared venv — **один на машину для всех волтов**, swap torch затрагивает всех консьюмеров.

Stdout содержит блок `conflict`:
```json
{
  "kind": "shared_torch_variant",
  "current_shared_variant": "cpu",
  "requested_variant": "cuda_cu126",
  "shared_marker_path": "C:/Users/.../vault-tools/vault-semantic/.installed",
  "requesting_vault": "D:/Mushroom_Base",
  "other_registered_projects": ["D:/Fishing_Base", "D:/Recipes_Base"],
  "swap_cost_min": 7,
  "note": "Swap re-downloads torch wheel (~2.6 GB for CUDA, ~200 MB for CPU)..."
}
```

**Что делать:**

1. **Показать юзеру конкретный конфликт** структурированным multi-choice вопросом. Текст из полей `conflict`:
   - Сейчас shared venv на: `current_shared_variant`
   - Этот волт (`requesting_vault`) просит: `requested_variant`
   - Другие волты, использующие тот же shared venv: `other_registered_projects` (если пуст — упомяни «других волтов не зарегистрировано»)
   - Стоимость swap'а: ~`swap_cost_min` мин (download + reinstall)
   - Caveat из `note`: swap re-downloads torch, другие волты продолжат работать но reindex performance изменится.

2. **Варианты выбора (3):**
   - **A. Swap globally** — перезапусти install.mjs с input `_allow_torch_swap: true` (добавь это поле к INPUT_JSON). Все волты переедут на `requested_variant`. Reindex performance для остальных волтов изменится соответственно.
   - **B. Switch this vault's manifest** — открой `.claude/vault-manifest.yaml`, замени `config.vault-semantic.device` на `current_shared_variant` (cpu / cuda). Перезапусти install.mjs. Этот волт пойдёт по тому же variant что shared, swap не требуется.
   - **C. Skip module** — отложи решение, выведи в `next_steps` инструкцию как разрулить позже (поменять manifest либо у одного волта, либо у всех).

3. Накопить `actions` для итогового отчёта.

**Edge cases:**
- `other_registered_projects` пуст — единственный консьюмер, swap безопасен (нет других волтов которые пострадают). Всё равно спроси, но «риск низкий».
- Pre-v0.4.0 shared marker без `torch_variant` поля — guard молчит (`shared_variant === null`), drift swap в `ensureVenvAndInstall` срабатывает свободно. Это нормально для первой установки v0.4.0+ — после неё shared marker зафиксирует variant.

### Шаг 6.5. Routing setup (folders manifest section)

`folders[]` в манифесте — это **vault-level registry**, не привязанный к одному скиллу. Хранит для каждой тематической папки: `path`, `description`, `keywords`, опциональный `create_skill` (theme-specific creator). Читается:
- `skills-common::new-note` — основной потребитель (роутинг и delegation в create_skill).
- Любой кастомный `new-*` скилл волта может смотреть на `folders[]` для cross-skill awareness (например, `new-mushroom` знает в какую папку класть карточку, но `folders[]` помогает агенту понять что ещё есть в волте).
- `audit-note` / `fix-links` опционально используют `folders[].keywords` для domain-эвристик.

Поэтому Шаг 6.5 **не gated на конкретный модуль** — всегда читает `folders[]`, и решает спрашивать ли юзера на основе наличия note-creating скилла в волте.

#### 6.5.1 Прочитать секцию `folders` из манифеста.

Если в манифесте `folders:` отсутствует как ключ — трактовать как пустой список.

#### 6.5.2 Определить, есть ли в волте note-creating скилл

Detection — любой из критериев:
- `skills-common` в манифесте → точно есть `/new-note` (после Шага 6.1 он установится).
- В `<vault>/.claude/skills/` есть SKILL.md, имя директории которого матчится `^new-` (новый кастомный скилл создания заметок, например `new-mushroom`, `new-recipe`, `new-picking-location`).

Если **нет** ни skills-common, ни `new-*` скиллов — Шаг 6.5.3 пропускает prompt (нечем использовать `folders[]` прямо сейчас). `folders[]` остаётся как есть, секция в финальном отчёте по-прежнему отображается (6.5.4) — пользователь сможет позже добавить новый скилл и заполнить registry.

#### 6.5.3 Если `folders` отсутствует/пуст И note-creating скилл найден:

- Просканировать top-level директории волта (исключая `.claude/`, `.obsidian/`, `attachments/`, `SYSTEM/`).
- Если найдены непустые тематические директории — спросить пользователя про каждую: «Это тематическая папка волта? Дайте короткое описание (и опционально — какой `create_skill` обрабатывает создание в ней)». Записать ответы в `folders[]`.
- Если волт пустой и top-level директорий нет — спросить: «Назовите 2–4 основных тематических раздела волта (можно сейчас оставить пустым и добавлять по ходу через `/new-note` или вручную в манифест)». Записать ответы.
- Если пользователь отказывается заполнять — оставить `folders: []` и добавить явное предупреждение в финальный отчёт (см. Шаг 7).

#### 6.5.4 Если `folders` уже заполнен:

- Прочитать существующие записи и показать в финальном отчёте (см. Шаг 7, Routing-секция).
- Не модифицировать без явного запроса пользователя.

#### 6.5.5 Edge case: `folders[]` заполнен, но note-creating скиллов нет

Не warning, информационная нотка в финальном отчёте: «`folders[]` объявлен, но ни одного `new-*` скилла в волте не найдено. Registry готов к использованию, но потребителей пока нет — добавь `skills-common` в манифест или свой кастомный `new-*` скилл, чтобы registry начал работать».

### Шаг 7. Final report

**Цель: пользователь видит полную картину состояния и точно знает, что делать дальше.** Никаких пересказов и упущений.

Структура отчёта:

#### 1. Итоги по модулям
Таблица: модуль → версия → статус (`installed` / `updated` / `skipped (already up-to-date)` / `failed`).

#### 2. Состояние компонентов (если запущен `--check` или были изменения)
Для каждого модуля — список компонентов из его status, чтобы видеть детали (например, `layout: legacy` для vault-index, `system_templates: 4/6 present` для core).

#### 3. Routing (всегда, независимо от skills-common)

**Отдельный видимый блок про папки волта.** Цель — пользователь должен явно увидеть, что объявлено в `folders[]` и куда будут роутиться новые заметки. Секция показывается **всегда**, потому что `folders[]` — vault-level registry, читаемый любым `new-*` скиллом (см. Шаг 6.5).

Формат если `folders` заполнен **и** note-creating скилл (skills-common или кастомный `new-*`) присутствует:
```
### Routing

Объявлено папок: N
  ✓ FOLDER1/   (description) → create_skill: /new-foo
  ✓ FOLDER2/   (description)
  ...

Потребители: /new-note (skills-common) | /new-mushroom | /new-foo

Чтобы добавить/изменить:
  • интерактивно — /new-note (предложит при отсутствии подходящей)
  • вручную — раздел `folders` в .claude/vault-manifest.yaml
  • документация — SYSTEM/Vault_architecture.md
```

Формат если `folders` пуст **и** note-creating скилл есть (пользователь отказался заполнить на Шаге 6.5.3):
```
### Routing

⚠  Не объявлено ни одной папки.

Это значит, что /new-note (или кастомный new-* скилл) при первом вызове
попросит вас определить структуру. Альтернатива — добавить раздел
`folders` в манифест вручную до начала работы.

См. SYSTEM/Vault_architecture.md (заполняется параллельно).
```

Формат если `folders` заполнен **но** note-creating скиллов нет (6.5.5):
```
### Routing

Объявлено папок: N (registry готов к использованию)
  ○ FOLDER1/   (description)
  ○ FOLDER2/   (description)
  ...

ℹ  Ни одного `new-*` скилла в волте не найдено — registry не имеет
   потребителей прямо сейчас. Добавь `skills-common` в манифест или
   свой кастомный `new-*` скилл, чтобы запустить роутинг.
```

Формат если `folders` пуст **и** note-creating скиллов нет:
```
### Routing

— `folders[]` не объявлен, note-creating скиллов нет. Routing неактивен.
   Добавишь `new-*` скилл или `skills-common` — `/init-vault` спросит
   про папки на следующем запуске.
```

#### 4. ⚠️ Warnings (отдельный заголовок, видимая секция)
**Все** warnings от **всех** модулей — **дословно**, с указанием от какого модуля. Не сокращать, не пересказывать. Если warnings нет — секцию пропустить.

Формат:
```
### ⚠️ Warnings

**vault-index** — `legacy_mcp_layout`:
> Используется legacy layout: MCP source в .claude/mcp-server/. Это работает, но не переносится при копировании portable bundle. (...)
```

#### 5. 📋 Next steps (отдельный заголовок, видимая секция)
**Все** `next_steps` от **всех** модулей — **дословно**. Это конкретные действия, которые пользователь должен выполнить. Если next_steps нет — секцию пропустить.

Формат:
```
### 📋 Next steps

1. **vault-index:** Регистрация в ~/.claude.json — пока вручную (см. документацию модуля).
2. **vault-index:** Миграция на canonical layout — опциональна (...).
```

**КРИТИЧНО:**
- Warnings и next_steps **никогда не упускаются**. Если модуль их вернул — они в отчёте.
- Не объединять warnings из разных модулей в одно общее сообщение — каждый со своим источником.
- Не интерпретировать и не «улучшать» формулировки модулей. Дословно.
- Если ни одного warning'а и next_step'а нет — это явно сказать в отчёте: «Никаких warnings или next_steps не получено».

## Интерактивный режим (без манифеста)

Если `.claude/vault-manifest.yaml` отсутствует:
1. Вывести список доступных модулей (все папки в `.claude/modules/`).
2. Для каждого — показать `description` из `module.yaml` и `mandatory: true/false`.
3. Спросить пользователя, какие включить (mandatory отмечены автоматически).
4. Auto-detect язык волта: прочитать первые 20 `.md` файлов в волте, определить преобладающий (RU/EN на глаз достаточно).
5. Сгенерировать манифест, показать пользователю на подтверждение, записать в `.claude/vault-manifest.yaml`.
6. Перейти к **Шагу 3**.

## Формат запуска handler'а

Handler читает INPUT_JSON из **stdin**. Канонический способ — **одностроковый** JSON через `echo … | node`, он портативен между bash и PowerShell (одинарные кавычки = литерал в обоих shell'ах, pipe направляет в stdin в обоих):

```bash
echo '{"vault_root":"D:/Vault","module_name":"<name>","module_dir":"D:/Vault/.claude/modules/<name>","config":{},"language":"ru","harness":["claude-code"],"platform":"win32"}' | node .claude/modules/<name>/ops/<op>.mjs
```

Используй **forward slashes** в путях (`D:/Vault`) — валидно в JSON и не требует экранирования. Одинарные кавычки вокруг JSON обязательны (литеральная строка, без интерполяции `$`).

> [!warning] Shell-портативность
> **Bash heredoc** (`node … <<'EOF' … EOF`) удобен для многострочного JSON, но **в PowerShell не работает** (heredoc там нет — это всплыло в Phase 6.2b на Opencode/Windows). Если нужен многострочный ввод именно в PowerShell — используй single-quoted here-string: `@'`…JSON…`'@ | node …`. Кросс-shell дефолт — одностроковый `echo '…' | node …` выше.

**Для shared-модулей** (см. Шаг 6.0) INPUT_JSON расширяется:
```json
{
  "vault_root": "...",
  "module_name": "vault-semantic",
  "module_dir": "...",
  "install_scope": "shared",
  "shared_module_dir": "C:/Users/<user>/AppData/Local/vault-tools/vault-semantic",
  "source_sha": "abc...",
  "version": "0.1.0",
  "config": {},
  ...
}
```
Эти поля приходят из stdout `core/lib/shared_install.mjs`. Подробно: `docs/Shared_Install_Architecture.md` §7.1.

## КРИТИЧНО

1. **Никогда не запускать install без предшествующего status.** Status даёт картину, install идёт по плану.
2. **При первой ошибке install — стоп.** Не пытайся продолжать с другими модулями: они могут зависеть от поломанного.
3. **Не редактировать `.claude/modules/<name>/.installed` руками.** Это маркер состояния, его пишет только `install.mjs`.
4. **Не перезаписывать `vault-manifest.yaml` без явного согласия пользователя** — пользователь мог его отредактировать.
5. **Финальный отчёт — обязателен**, даже если ничего не делалось. Покажи пользователю текущее состояние всех модулей.
6. **Язык всего user-facing narrative — `manifest.language`.** Это значит:
   - Status-апдейты между шагами («Now running status checks», «Pre-install for shared vault-semantic», «Handler needs torch decision») — на языке манифеста.
   - Текст structured-question диалога (заголовок вопроса, labels опций, descriptions) — на языке манифеста.
   - Финальный отчёт целиком (заголовки секций, формулировки статусов, дополнительные пояснения) — на языке манифеста.
   - Прямые цитаты warnings/next_steps из handler stdout — **как есть** (модули сами решают на каком языке возвращать тексты; не переводи их).
   - Программные event-имена в `actions[]` (`pip_install_done`, `torch_variant_resolved`, `nvidia_smi_probe` и т.д.) — **всегда английские**, не переводи.

   Дефолт без указанного манифеста = `en`. Если манифест говорит `ru` — весь narrative русский; если `en` — английский; если другой — соответствующий язык (best effort).

## Текущие ограничения

- **Update-логика** отсутствует: `outdated` → запускается install повторно (модули сами идемпотентны).
- **Remove-операция** не поддерживается.
- **Интерактивный режим** — реализован в части генерации простого манифеста (modules + language). Routing-папки (Шаг 6.5) проходят интерактивно даже при наличии манифеста, если секция `folders` пуста.
