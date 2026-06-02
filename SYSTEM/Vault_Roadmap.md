---
type: guide
domain: system
stability: evolving
priority: medium
tags:
  - roadmap
  - planning
---

# Vault Roadmap — идеи к обсуждению

> Долговременная память между сессиями: что хочется проработать. Пункты в общих чертах — детализируются при заходе на реализацию. Отличается от `Vault_Bootstrap_Roadmap.md` (там — роадмап самого framework'а).

## 1. Type-aware audit качества реализации карточки

**Идея.** Скилл аудита, который в зависимости от `note_kind` проходит по **алгоритму создающего скилла** (`/new-anime`, `/new-character`, `/new-person`, `/new-studio`) и проверяет, что **все его пункты реализованы качественно**: все обязательные секции на месте, frontmatter-поля корректны, gallery/cast-секции в нужном формате, реципрокные связи замкнуты, постер/миниатюры расставлены и т.д.

**Зачем.** Создающие скиллы — это де-факто спека «как выглядит полная и правильная карточка». Карточки, сделанные слабыми моделями (mimo/GLM через Opencode), пропускают шаги (битый постер у Kubo_Shiori, отсутствие в каст-таблице, языковой мусор, неверная реципрокность). Нужен проход, который ре-применяет ожидания создающего скилла к существующей карточке и ловит дрейф/недореализацию.

**Развилка реализации:**
- **(а)** Новый отдельный аудит-скилл, или
- **(б)** Дорастить существующий `/audit-note` условием «по `note_kind` подтянуть чек-лист создающего скилла».

**Открытые вопросы / ограничения:**
- `/audit-note` — это **framework-managed** скилл (`skills-common`, `.managed`). Его модификация = слой фреймворка → либо запрос мейнтейнеру, либо новый **vault-owned** тематический аудит-скилл (без `.managed`, как create-скиллы). См. границу слоёв в правилах волта.
- Где живёт «чек-лист по типу»: дублировать алгоритм создающего скилла нельзя (рассинхрон). Нужен общий источник — возможно, вынести «definition of done» по каждому `note_kind` в `SYSTEM/` (как `Audit_checklist.md` уже делает для type-conditional шагов §4.6), и чтобы и create-скилл, и аудит читали один источник.
- Пересечение с уже существующим `Audit_checklist.md §4.6` (type-conditional) — возможно, это его расширение, а не новый скилл.

## 2. Системная заметка «здоровье волта» (Dataview-дашборд)

**Идея.** SYSTEM/дашборд-заметка, отображающая здоровье волта через **Obsidian Dataview**-запросы:
- заметки в `quality: draft` (не подтверждённые);
- возможные кандидаты: stub'ы (тонкие заметки), orphans (без входящих/исходящих), карточки без `images.cover`, незакрытая реципрокность, `co_authored` от слабых моделей под ре-аудит, и т.п.

**Зачем.** Один экран, где видно, что требует внимания, вместо ручного обхода. Ложится на принцип self-heal: дашборд показывает «фронт работ».

**Открытые вопросы:**
- Dataview — это привязка к плагину (в отличие от материализованных gallery-секций, которые волт намеренно держит plain-Markdown). Для **дашборда** это приемлемо — он чисто навигационный, не контент. Зафиксировать это решение.
- Что из «здоровья» брать из Dataview (по frontmatter-полям), а что — из MCP-tools `vault-index` (`vault_orphans`, `vault_lint`, `vault_asymmetric_links`, `vault_image_status`), которые видят граф/ссылки, недоступные Dataview. Возможно, гибрид: Dataview по frontmatter + периодический срез от MCP-tool'ов.

## 3. Доработка `manga`-kind + кросс-режущие метаданные (СОГЛАСОВАНО, в работе)

> Полный план: `~/.claude/plans/cozy-baking-otter.md` (одобрен 2026-06-02). Ниже — самодостаточное резюме на случай, если план-файл подчистят. Статус этапов отмечать здесь.

**Контекст.** `manga`-kind вчерне создан; планирование вскрыло неоднозначности (часть задевает anime/character/person). Закрываем единым заходом.

**Решения:**
1. `manga` — зонтичный kind для всех рисованных носителей. Поле **`tradition`**: `manga|manhwa|manhua|rumanga|comic` (origin, без оси format). Доп. полей под комиксы нет.
2. **Оценочные оси** (1–10, USER-ONLY, always-present `null`), общие anime+manga: `art_score`, `story_score`, `originality_score`. `personal_score` — общая независимая ось; `opening`/`ending_score` — только anime.
3. **Общий принцип:** любое USER-ONLY personal-rating поле — always-present `null`, не удаляется (queryability + анти-silent-drop).
4. **Фикс дыры:** `character.personal_score` отсутствует во всех 17 карточках → промоут в always-present `null` + бэкафилл.
5. **Реципрокность manga↔person(автор)** — реципрокно (как `anime.staff↔person.works`): `person.works[]` принимает MANGA, `## Ключевые работы` включает мангу, `reciprocity_pairs += [manga,person]/[person,manga]`. manga↔character/anime уже заложены. Severity ERROR (глобальный); forward от позже-созданных карточек — backstop (`/fix-links asymmetric`).
6. **Adult без нового kind:** поле `content_rating` (`sfw|nsfw|explicit`, default sfw, модель-заполняемое из AniList isAdult/жанров). Adult-жанры в общий `genres`; adult-теги — отдельная категория `Tag_taxonomy` (только при nsfw/explicit). Источник — AniList. Синопсис неграфичный; жёсткий предел — никаких несовершеннолетних в сексуальном контексте. Обложки adult — качаем как обычно, не прошло политику → пометка, пользователь руками.
7. **Доп. manga-поля:** `translation_status` (`complete|ongoing|abandoned|on-hold|none`, user-filled), `coloring` (`black-and-white|full-color|partial`, model best-effort), ёнкома — тег `yonkoma`. `last_chapter_read` уже есть (USER-ONLY).

**Затрагивает:** `enums.yaml`, `Metadata_schema`, `Linking_guidelines`, `Tag_taxonomy`, манифест (reciprocity_pairs), скиллы `/new-manga`,`/new-anime`,`/new-character`,`/new-person`,`/audit-review`, `.obsidian/types.json` (number для осей) + свипы (anime: +оси+content_rating; characters: +personal_score). Managed-слой не трогаем.

**Этапы:** ✅ A (e841722 — схема+enums+манифест+типы) ✅ B (2ffd790 — скиллы) ✅ C (5270052 — свипы: 6 anime +оси/content_rating, 17 characters +personal_score) ✅ Верификация механическая (vault_lint 0 issues, dup-basenames 0). ☐ Живой E2E `/new-manga` + adult-кейс — за пользователем (создание реального контента, не авто).
