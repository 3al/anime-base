---
name: fix-links
description: >
  Find and fix broken WikiLinks, duplicate links, and orphan notes.
  Use when the user says /fix-links, "почини ссылки", "broken links",
  "проверь граф", or wants to audit the link health of the vault.
argument-hint: "[broken | duplicates | orphans | all] [папка]"
model: sonnet
---

# /fix-links — Поиск и исправление проблем со ссылками

Комплексная проверка и ремонт WikiLinks в vault.

## Аргументы

`$ARGUMENTS` — парсить как `[тип] [папка]`:
- **Тип проверки** (первое слово, по умолчанию `all`): `broken`, `duplicates`, `orphans`, `lint`, `all`
- **Папка** (остальное, опционально): путь для ограничения поиска

Примеры:
- `/fix-links` — все проверки, весь vault
- `/fix-links broken` — только сломанные, весь vault
- `/fix-links lint AI/Models` — только lint, только AI/Models
- `/fix-links all AI/Models` — все проверки, только AI/Models
- `/fix-links duplicates PRINCIPLES` — только дубликаты в PRINCIPLES

## Источники правил

Перед работой прочитай:

1. **`SYSTEM/Linking_guidelines.md`** — правила линковки

## MCP-инструменты (vault-index)

Для механических проверок использовать MCP-tools из сервера `vault-index`:

| Tool | Параметры | Что возвращает |
|------|-----------|----------------|
| `vault_broken_links` | `{ folder? }` | `{ broken: [{ file, line, target }], count }` |
| `vault_duplicate_links` | `{ folder? }` | `{ duplicates: [{ file, target, count }], count }` |
| `vault_orphans` | `{ folder? }` | `{ orphans: [{ file, type, domain }], count }` |
| `vault_lint` | `{ target?, showAll? }` | `{ files: [...], summary }` |

Все tools принимают опциональный параметр `folder`. Передавать папку из `$ARGUMENTS` если указана.

## Алгоритм

### 1. Диагностика

Вызвать MCP-tools в зависимости от аргумента (`all` = все три: broken_links, duplicate_links, orphans).

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

### 5. Отчёт

```
## Результат /fix-links

| Проверка | Найдено | Исправлено |
|---|---|---|
| Сломанные ссылки | N | N |
| Дубликаты | N | N |
| Сироты | N | → /link-orphans |
```

Спросить пользователя перед применением исправлений. Показать diff для каждого изменения.
