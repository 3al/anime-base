---
name: fix-links
description: >
  Find and fix broken WikiLinks, duplicate links, and orphan notes.
  Use when the user says /fix-links, "почини ссылки", "broken links",
  "проверь граф", or wants to audit the link health of the vault.
argument-hint: "[broken | duplicates | orphans | asymmetric | all] [папка]"
model: sonnet
---

# /fix-links — Поиск и исправление проблем со ссылками

Комплексная проверка и ремонт WikiLinks в vault.

## Аргументы

`$ARGUMENTS` — парсить как `[тип] [папка]`:
- **Тип проверки** (первое слово, по умолчанию `all`): `broken`, `duplicates`, `orphans`, `asymmetric`, `lint`, `all`
- **Папка** (остальное, опционально): путь для ограничения поиска

Примеры:
- `/fix-links` — все проверки, весь vault
- `/fix-links broken` — только сломанные, весь vault
- `/fix-links lint AI/Models` — только lint, только AI/Models
- `/fix-links all AI/Models` — все проверки, только AI/Models
- `/fix-links duplicates PRINCIPLES` — только дубликаты в PRINCIPLES
- `/fix-links asymmetric` — только односторонние межкарточные связи

## Источники правил

Перед работой прочитай:

1. **`SYSTEM/Linking_guidelines.md`** — правила линковки
2. **`.claude/vault-manifest.yaml` → `reciprocity_pairs`** — только для под-режима `asymmetric`: список kind-пар `[sourceKind, targetKind]`, реципрокность которых держится на конвенции (а не на frontmatter-FK). Поле опциональное, дефолт `[]` (opt-in). Пусто или отсутствует → под-режим `asymmetric` пропускается.

## MCP-инструменты (vault-index)

Для механических проверок использовать MCP-tools из сервера `vault-index`:

| Tool | Параметры | Что возвращает |
|------|-----------|----------------|
| `vault_broken_links` | `{ folder? }` | `{ broken: [{ file, line, target }], count }` |
| `vault_duplicate_links` | `{ folder? }` | `{ duplicates: [{ file, target, count }], count }` |
| `vault_orphans` | `{ folder? }` | `{ orphans: [{ file, type, domain }], count }` |
| `vault_asymmetric_links` | `{ sourceKind, targetKind, folder? }` | `{ pairs: [{ source, sourcePath, line, target, targetPath, missingReverse }], count }` |
| `vault_lint` | `{ target?, showAll?, reciprocityPairs? }` | `{ files: [...], summary }` |

Все tools принимают опциональный параметр `folder`. Передавать папку из `$ARGUMENTS` если указана.

## Алгоритм

### 1. Диагностика

Вызвать MCP-tools в зависимости от аргумента (`all` = broken_links, duplicate_links, orphans + asymmetric, если `reciprocity_pairs` непуст).

При вызове `vault_lint` (тип `lint`, либо в составе `all`): если `reciprocity_pairs` в манифесте непуст — передать его как `reciprocityPairs`, чтобы асимметрия всплыла `asymmetric-link` прямо в lint-выводе (на стороне карточки, которой не хватает обратной ссылки). Severity — из `vault-manifest.yaml::asymmetry_severity` (дефолт `WARN`; передать как `asymmetricSeverity`, если поле задано). Это слой непрерывной видимости; фактический ремонт — под-режим `asymmetric` (шаг 4.5).

Если все tools вернули пустые массивы (count: 0) — сообщить «Проблем не найдено» и завершить.

### 2. Исправление сломанных ссылок

Для каждой записи из `vault_broken_links`:
1. Прочитать файл и строку с проблемой
2. Найти через Glob файл с похожим именем (fuzzy: без дефисов/подчёркиваний, другой регистр, частичное совпадение)
3. Если найден единственный кандидат — предложить замену
4. Если кандидатов несколько — показать варианты
5. Если кандидатов нет — предложить удалить WikiLink и оставить plain text

Варианты действий:
- `[[Old_Name]]` → `[[New_Name]]` (переименование)
- `[[Old_Name]]` → `Old_Name` (удаление ссылки, target не существует)
- `[[Old_Name]]` → `[[New_Name|Old Name]]` (переименование с сохранением текста)

### 3. Исправление дубликатов

Для каждой записи из `vault_duplicate_links`:
1. Прочитать файл, найти все вхождения `[[Target]]`
2. Оставить WikiLink на **первом** смысловом упоминании (по Linking_guidelines)
3. Заменить остальные на plain text (убрать `[[` и `]]`)
4. Если дубликат в секции «Связанные заметки» — удалить строку целиком (ссылка уже есть в теле)

### 4. Перенаправление на orphans

Если аргумент `orphans` или `all` — сообщить пользователю количество сирот из `vault_orphans` и предложить запустить `/link-orphans` для детального анализа и интеграции.

### 4.5. Исправление асимметричных связей

Запускать только при аргументе `asymmetric` или `all`, и только если `reciprocity_pairs` в манифесте непуст. Иначе — пропустить молча.

Контекст: `vault_text_mentions` по контракту гасит строки с уже-стоящим линком (идемпотентность). Поэтому односторонняя связь A→B без B→A для text-mention-слоя невидима — нужен граф-детектор `vault_asymmetric_links`.

1. Прочитать `reciprocity_pairs` из `.claude/vault-manifest.yaml`. Для каждой пары `[sourceKind, targetKind]` вызвать `vault_asymmetric_links({ sourceKind, targetKind, folder? })` (передать `folder` из `$ARGUMENTS`, если указана).
2. Агрегировать `pairs` со всех вызовов.
3. Для каждой записи `{ source, sourcePath, line, target, targetPath, missingReverse: { from, to } }`:
   - `missingReverse.from` = карточка, которой не хватает обратного линка (B); `missingReverse.to` = на кого линковать (A).
   - Прочитать forward-линк (`sourcePath:line`) для контекста связи.
   - Дописать в карточку B (`targetPath`) обратный навигационный линк на A в **связевую секцию по конвенции волта**.
4. **Формат обратного линка определяется тематическим слоем волта, не хардкодится здесь.** Прочитать `SYSTEM/Linking_guidelines.md` (+ при наличии — формат связевой/галерейной секции конкретного `note_kind`) и применить его: например, конвертировать plain-текст имени в навигационную запись с галерейной миниатюрой, если конвенция волта такова. Описание/контекст связи дописывает модель по смыслу forward-связи.
5. Per-file confirm: показать diff каждой правки карточки B перед применением.

Ограничение области (важно против false-positive): проверяются **только** kind-пары из `reciprocity_pairs`. Классы, где реципрокность держится на frontmatter-FK (а не на конвенции тела), в список не включаются — их односторонний body-линк не дефект.

### 5. Отчёт

```
## Результат /fix-links

| Проверка | Найдено | Исправлено |
|---|---|---|
| Сломанные ссылки | N | N |
| Дубликаты | N | N |
| Сироты | N | → /link-orphans |
| Асимметричные связи | N | N |
```

Спросить пользователя перед применением исправлений. Показать diff для каждого изменения.
