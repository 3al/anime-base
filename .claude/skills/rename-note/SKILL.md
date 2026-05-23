---
name: rename-note
description: >
  Rename or move a vault note, updating all WikiLinks across the vault.
  Use when the user says /rename-note, "переименуй заметку", "перенеси заметку",
  "move note", "rename note", or wants to change a note's name or location.
argument-hint: "<старое имя> <новое имя и/или папка>"
model: sonnet
---

# /rename-note — Переименование и перемещение заметок

Переименовывает и/или перемещает заметку, обновляя все WikiLinks по vault.

## Аргументы

`$ARGUMENTS` — парсить как `<source> <target>`:

| Формат | Действие |
|---|---|
| `Old_Name New_Name` | Переименование (в той же папке) |
| `Old_Name Folder/` | Перемещение (имя сохраняется) |
| `Old_Name New_Name Folder/` | Переименование + перемещение |

`source` — имя файла (без `.md`) или относительный путь. Если только имя — найти через Glob.

Примеры:
- `/rename-note Ollama Local_LLM_Ollama` — переименовать
- `/rename-note CUDA AI/Concepts/` — перенести в другую папку
- `/rename-note CUDA GPU_Computing AI/Concepts/` — переименовать и перенести

## Источники правил

Перед работой прочитай:

1. **`SYSTEM/Naming_conventions.md`** — формат имени файла
2. **`SYSTEM/Vault_architecture.md`** — дерево решений «куда класть заметку»
3. **`SYSTEM/Linking_guidelines.md`** — правила WikiLinks

## Алгоритм

### 1. Найти исходный файл

Найти через Glob. Если не найден — сообщить и завершить.

### 2. Валидация нового имени

Если задано новое имя:
- Проверить формат по Naming_conventions (`PascalCase_With_Underscores`)
- Проверить что файл с таким именем не существует (Glob)
- Если имя содержит кириллицу — предупредить и предложить латинский вариант + alias

### 3. Валидация целевой папки

Если задана папка:
- Проверить что папка существует
- Проверить что заметка подходит по правилам Vault_architecture (тип заметки → целевая папка)
- Предупредить если заметка не соответствует дереву решений

### 4. Показать план и запросить подтверждение

```
## План /rename-note

| | Было | Стало |
|---|---|---|
| Файл | Old_Path/Old_Name.md | New_Path/New_Name.md |
| WikiLinks | [[Old_Name]] (N файлов) | [[New_Name]] |
| Aliases | [alias1] | [alias1, Old_Name] |

Файлы для обновления WikiLinks:
- ...

Применить?
```

**Не применять без подтверждения пользователя.**

### 5. Выполнить переименование/перемещение

Порядок операций (строго последовательно):

**5.1. Добавить старое имя в `aliases`** (если переименование)
- Прочитать frontmatter
- Добавить старое имя файла (без `.md`) в массив `aliases`
- Если `aliases` нет — создать

**5.2. Обновить `updated`** в frontmatter на сегодняшнюю дату.

**5.3. Переименовать/переместить файл**
```bash
git mv "старый/путь/Old_Name.md" "новый/путь/New_Name.md"
```
Использовать `git mv` чтобы git отследил перемещение.

**5.4. Обновить все WikiLinks по vault**

Найти все файлы, ссылающиеся на старое имя, через MCP-tool `vault_backlinks` с `note: Old_Name`.

В каждом файле заменить:
- `[[Old_Name]]` → `[[New_Name]]`
- `[[Old_Name|текст]]` → `[[New_Name|текст]]`
- `[[Old_Name\|текст]]` → `[[New_Name\|текст]]` (в таблицах)

**Не трогать:**
- Ссылки внутри code blocks
- Ссылки в `.claude/` директории

### 6. Верификация

После выполнения:
- Вызвать MCP-tool `vault_broken_links` — проверить что нет сломанных ссылок
- Проверить что старое имя больше не встречается как WikiLink target
- Сообщить результат

### 7. Отчёт

```
## Результат /rename-note

- Переименован: Old_Name.md → New_Name.md
- Перемещён: Old_Path/ → New_Path/
- Обновлено WikiLinks: N файлов
- Добавлен alias: Old_Name
- Сломанных ссылок: 0
```
