---
type: guide
domain: system
stability: stable
priority: low
tags:
  - roadmap
  - planning
  - archive
---

# Vault Roadmap — Архив закрытого

> Закрытые пункты `Vault_Roadmap.md`, вынесенные сюда, чтобы не размывать активный фронт работ. Каждая запись сжата до: **что отгружено** + версия/коммит + **durable-решение / отвергнутая развилка** (то, что нельзя терять — иначе спор переоткроют). Полнотекст любого пункта — в git-истории `Vault_Roadmap.md`. Номера §N сохранены как стабильные ID (на них ссылается активный роадмап и память).

## §1 — Type-aware audit (структурный аудит по создающему скиллу)

**РЕАЛИЗОВАНО** 2026-06-03, skills-common 0.5.0 @ a9c1dad. Скилл `/audit-by-creator` (`.managed`), kind-agnostic, читает `/new-<kind>` по `note_kind`, выводит артефактные инварианты, сверяет, чинит безопасную механику. Контракт: `audit-by-creator/references/ledger-protocol.md`.
**Durable-решения:** источник истины = **сам текст создающего скилла** (отдельный DoD-док **ОТВЕРГНУТ** — рассинхрон by construction); managed-`/audit-note` под структуру не правим (отдельный скилл); **объединён с §6** (оценка модели — побочный эффект того же прохода).

## §3 — Доработка `manga`-kind + кросс-режущие метаданные

**ЗАКРЫТО** 2026-06-11 (vault-side). Зонтичный `manga`-kind со всеми 7 решениями отгружен и проверен вживую. Этапы A (e841722 — схема+enums+манифест+типы) / B (2ffd790 — скиллы) / C (5270052 — свипы) + E2E `/new-manga` (`Maria-sama_ga_Miteru_(manga)`, реципрокность замкнута, asymmetric 0).
**Сверка 2026-06-11:** `tradition`/`content_rating`/`coloring`/`translation_status`/`publisher`/`art_score`/`story_score`/`originality_score` — в карточке; `character.personal_score` держится **43/43** (новые `/new-character` тоже кладут); reciprocity `manga↔person`/`character`/`anime` — в манифесте.
**Adult-путь построен целиком** в `/new-manga` (детект AniList `isAdult`+жанры, неграфичная проза, жёсткий предел про несовершеннолетних, политика обложек). «Adult-кейс за пользователем» = **триггер** на создание реального adult-контента, не инженерная работа. Adult-категория тегов `Tag_taxonomy` наполняется **при первом nsfw/explicit-тайтле** (формулировка скилла смягчена 2026-06-11, чтобы висячая ссылка не путала).
**Породил follow-up'ы** §4 (light-novel: kind vs `tradition`) и §7 (PUBLISHERS-kind) — отдельные открытые пункты активного роадмапа.

## §6 — Леджер качества моделей (Opus-судья)

**РЕАЛИЗОВАНО** 2026-06-03, skills-common 0.5.0 @ a9c1dad (merged §1). `SYSTEM/model_quality.jsonl` пишут `/audit-by-creator` (`structural`) + `/audit-note` (`content`); схема v:1, нормализация ID, `pristine`, «аудит не авторствует». `/audit-review` в леджер НЕ пишет.
**Durable-решения:** оценка **встроена в аудит** (отдельный `/rate-note` **ОТВЕРГНУТ** — один проход); `co_authored` затирается **последним шагом ПОСЛЕ** записи в леджер (порядок снимает «судья перепишет автора»); запись хранит `authored_model`+`judge_model`+`audit_type`; JSONL (не SQLite/MD). Single-judge bias оговорён: ок для **относительного** сравнения (единый эталон).

## §8 — `online_url` потребление

**СДЕЛАНО** 2026-06-02. USER-ONLY поле `online_url` (стриминг для anime, ридер для manga) в `Metadata_schema` + `/new-anime`/`/new-manga`. Отлично от каталожных `mal_url`/`anilist_url`. Задаёт контекст нумерации `last_chapter_read`/`last_episode_watched` (сканлейт-ридеры перенумеровывают главы).

## §18 — epoch-conformance (балл за качество модели, не за дрейф схемы)

**ЗАКРЫТО.** `SYSTEM/spec_changelog.yaml` + epoch-реклассификация `ledger-protocol §4.1` + детерминированный backstop `vault_spec_drift`. Балл считается **только против требований, существовавших на дату `created`**; требование с датой ввода `> created` → класс `SCHEMA_DRIFT` (репортится/фиксится как долг §16, но **в score не входит**). Ретро-сев базы сделан историч. датами.
**Durable-решения (settled 2026-06-03):** (a) отдельный `spec_changelog.yaml`, не `since:` на поле; (b) поля логировать строго, format/convention — best-effort; (c) эпоха = `created`. Механизм — framework; контент changelog — vault-side. Мотивация: иначе schema-drift штраф занижает **Opus-baseline** (старые карточки = Opus), слабые модели на его фоне выглядят лучше.

## §19 — флаги `--report-only` / `--no-ledger` для `audit-note`

**ЗАКРЫТО.** `audit-note` (skills-common) несёт `--report-only` / `--no-ledger` / `--no-network` — симметрия с `audit-by-creator` восстановлена, dry-run и приостановка леджера возможны.

## §20 — `vault_query` фильтр по произвольному frontmatter-полю

**ЗАКРЫТО**, vault-index 0.7.0, принято 2026-06-06. `vault_query` принимает generic where: `fieldEquals` / `fieldGte` / `fieldIn` (dot-path, напр. `images.cover`) + `fields`-проекция запрошенных `extra`-полей. Движок уже хранил весь не-core frontmatter в `record.extra` — было surface-расширение tool'а, не индексатора.

## §22 — `audit-by-creator` проверяет МАРК-АП reverse-leg, не только существование ссылки

**ЗАКРЫТО**, vault-index 0.7.0 / skills-common 0.8.0, принято 2026-06-06. Lint-правило `broken-table-row` (always-on, structural): cell-count строки ≠ шапке / неэкранированный `|` в `[[...]]` внутри table-ячейки → ERROR. `audit-by-creator` инспектирует марк-ап reverse-leg-артефакта (не только факт линка).
**Durable (fix-scoping §22):** судья чинит **только** строки/записи субъекта аудита; чужие со-локализованные дефекты → флаг vault-долга (чинятся при аудите ИХ автора), не молчком — иначе self-heal завышает чужой structural-score (межкарточный аналог `pristine`). См. `feedback_audit_fixes_scoped_to_subject_author`.

## §23 — судья проверяет КОНСИСТЕНТНОСТЬ/ЛЕГИТИМНОСТЬ, не только присутствие

**ЗАКРЫТО**, vault-index 0.7.0/0.7.1 / skills-common 0.8.0, принято 2026-06-06. Два класса сигнала разведены: **`structural`** (`broken-table-row`, `cover-ref-mismatch`, `name-surface-mismatch`, `empty-tags` — гейтят `structural_green`) vs **`heuristic`** (`user-only-fabricated`, `mixed-script-prose` — opt-in, конфиг манифеста, отдельный поток, не влияют на green). `audit-by-creator` несёт пас консистентности §23 а/б/в (кросс-поверхностная консистентность имён, легитимность USER-ONLY-авторства, разлад создатель↔governance). FP F1 (name-surface) / F2 (callout-mask) пофикшены 0.7.1.
**Durable-решение (фидбек мейнтейнера):** **нельзя сплющивать эвристику под детерминизм** в один severity/поток — нечёткий WARN с бинарным ERROR эродирует доверие к сигналу (через месяц заглушат → бэкстоп умрёт). Языко-специфичную эвристику (back-romanization, `prose_script`) НЕ зашивать в core под видом «нейтральной» — только через конфиг/per-kind. См. `feedback_separate_deterministic_from_heuristic_checks`, `feedback_audit_checks_consistency_not_presence`.

## §24 — content-ось на СМЫСЛ/субстанцию (фактчек), БЕЗ новой оси оценок

**ЗАКРЫТО.** `audit-note §4.2` поднял смысловой фактчек субстанции (правдивость описаний связей + substance-grounding прозы) в **ядро**, не опцию; добавлен обязательный prose-clarity пасс §4.5. Vault-side `Audit_checklist.md` type-conditional (`character`/`anime`/`person`) дополнен.
**Durable-ограничение (требование пользователя):** **НЕ вводить дополнительную ось оценок / score-dimension** — остаётся findings-anchored content-score. Усиливается процедура судьи, не схема леджера.

## §26 — `tooling-vocab-in-prose` (heuristic lint против техшума в контенте)

**ЗАКРЫТО**, vault-index 0.8.0. Heuristic-правило (opt-in, конфиг манифеста `tooling_vocab`: `field_names` / `state_phrases` / `flag_skill_commands`): имена полей / vault-state фразы / имена скиллов `/...` в читательской прозе → WARN, отдельный поток, не гейтит structural-green. Маскирование переиспользует USER-ONLY-стаб-whitelist.
**Известный gap (→ §30 / память):** substring-whitelist не ловит **мутацию** стаба (команда внутри изменённого USER-ONLY-стаба шилдится). Durable-фикс — trim-equals masking. См. `project_tooling_vocab_stub_mask_blindspot`.

## §28 — генерализация reverse-leg-subject-artifact на остальные create-kinds

**ЗАКРЫТО** 2026-06-07 (vault-side). (1) Генерик-правило «Reverse-leg: владение и cover-sync (кросс-kind)» вынесено в `SYSTEM/Linking_guidelines.md` (единый источник, аудит читает транзитивно). (2) Пойнтеры в 7.5-секции `/new-anime`/`/new-person`/`/new-studio`/`/new-manga`. (3) Spec-requirement `reverse_leg_subject_artifact` (kind_of: format) раскатан в их spec-requirements + `spec_changelog.yaml` (introduced 2026-06-07 → пре-06-07 карточки = SCHEMA_DRIFT, не штраф). `vault_spec_drift` = 0. `character` = прототип (2026-06-06). См. `feedback_reverse_leg_propagation_on_cover_add`.

## §30 — честный `structural_green` (свернуть broken/duplicate-links в `vault_lint`)

**ЗАКРЫТО** (Приоритет 1), vault-index 0.8.2 / skills-common 0.9.2, развёрнуто+принято 2026-06-07 (commits f9dc2b2 → f8ef953). `broken-link` + `duplicate-link` свёрнуты в `vault_lint` как structural-ERROR (always-on, ~0 FP) → `summary.structural_green` честен про целость внутренних ссылок **by construction** (ошибка «зелёный lint → ссылки ок» стала верной). Standalone `vault_broken_links`/`vault_duplicate_links` сохранены. Внешние URL вне области (контраст §25). Бонус в той же ветке: выпилены 2 доменных хардкода (`vault_orphans` exempt → manifest-ключ `orphan_exempt`; `index.ts` VAULT_ROOT fallback → fail-loud).
**Не делалось:** Приоритет 2 (`vault_card_closed` bundle-tool) — опционален; после П1 гейт `/audit-card §7.1` схлопывается почти в `structural_green` + `asymmetric(P)`. См. `feedback_audit_must_run_link_tools`.

## §32 — `under_tag_discord`: порог большинства вместо «any-gap» + конфиг

**РЕАЛИЗОВАНО + ПРИНЯТО**, vault-index 0.9.1, развёрнуто 2026-06-08. `under_tag_mode` `majority` (новый дефолт) | `any` | `off` + конфиг-ручки `under_tag_present_fraction` (0.6) / `under_tag_max_missing` (2) через манифест; кандидаты ранжируются по confidence (тугие фасеты сверху), кап `under_tag_limit`. Приёмка: `any` 91 кандидат (59 — шум `present_on==1`) → `majority` 11 легит-кандидатов (−88% шума).
**Durable-инсайт:** фасет-со-членство ≠ тематическая близость. Тематические теги **по природе РАЗЛИЧАЮЩИЕ** (отделяют персонажей), а не общие → флагать только near-universal пропуски (тег на бо́льшей части группы, пропущен у единиц). Тул из «детектора консистентности тегов вообще» стал «детектором полноты почти-универсальных тегов в кластере». Остаток дыр → §33.
