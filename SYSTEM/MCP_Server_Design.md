---
type: guide
domain: system
stability: evolving
priority: high
co_authored: claude-opus-4.6
quality: verified
tags:
  - mcp
  - metadata
  - agent
created: 2026-03-25
updated: 2026-03-26
---

# MCP-сервер vault-index

Персистентный индекс vault, заменяющий bash-скрипты мгновенными запросами через MCP.

Документ выполняет три роли: (1) описание архитектуры конкретного сервера, (2) пошаговое руководство по созданию собственного MCP-сервера, (3) инструкция по запуску для нового пользователя vault.

## Мотивация

4 bash-скрипта в `.claude/scripts/` обходят vault с нуля при каждом вызове:
- `lint-vault.sh --all` — 10+ минут (сотни fork/exec: grep, sed, wc на каждый файл)
- `find-orphans.sh` — O(N^2) (grep по всему vault на каждый файл)
- При росте базы время растёт линейно/квадратично

MCP-сервер строит индекс один раз, хранит на диске в JSON, обновляет инкрементально по mtime. Все запросы — O(1) или O(N) по индексу в памяти. Полная индексация ~100 файлов — <100ms.

Причина скорости: bash-скрипт на каждый файл порождает десятки процессов (grep, sed, wc, awk) через fork/exec. Для 100 файлов это тысячи системных вызовов. Node.js делает всё в одном процессе: чтение файлов, парсинг YAML, поиск WikiLinks — чистая работа с памятью без порождения подпроцессов.

## Что такое MCP-сервер

MCP (Model Context Protocol) — открытый протокол, позволяющий LLM-агентам (Claude Code, Opencode и др.) вызывать внешние инструменты. MCP-сервер — это процесс, который:

1. **Запускается** клиентом (Claude Code) при старте сессии
2. **Общается** по стандартному протоколу (JSON-RPC 2.0 через stdio или HTTP)
3. **Регистрирует tools** — функции с именем, описанием и JSON Schema для параметров
4. **Обрабатывает вызовы** — получает запрос от клиента, выполняет логику, возвращает результат

Агент видит список tools с описаниями и решает когда и какой вызвать — точно так же, как вызывает встроенные Read, Edit, Grep.

## Выбор технического стека

### Официальные SDK

MCP — открытый протокол. Anthropic предоставляет официальные SDK на нескольких языках:

| SDK            | Пакет                                | Зрелость                                |
| -------------- | ------------------------------------ | --------------------------------------- |
| **TypeScript** | `@modelcontextprotocol/sdk`          | Референсная реализация, наиболее полная |
| **Python**     | `mcp` (PyPI)                         | Полноценный, активно развивается        |
| **Kotlin**     | `io.modelcontextprotocol:kotlin-sdk` | Стабильный                              |
| **C#**         | `ModelContextProtocol` (NuGet)       | Стабильный                              |

Также существуют community SDK на Go, Rust, Java, Ruby и других языках.

### Почему TypeScript + Node.js для этого проекта

- **Референсная реализация**: TypeScript SDK разрабатывается той же командой что и протокол, новые фичи появляются здесь первыми
- **Производительность для I/O задач**: индексация vault — это чтение файлов + парсинг текста. Node.js с асинхронным I/O идеален для этого
- **Экосистема**: `yaml` для YAML, `zod` для валидации схем — зрелые библиотеки
- **Минимум зависимостей**: 3 runtime-зависимости (sdk, yaml, zod), без бинарных модулей

Python SDK был бы равнозначным выбором. Kotlin/C# имеют смысл если MCP-сервер встраивается в существующее JVM/.NET приложение.

## Быстрый старт: как создать MCP-сервер

### Шаг 1: Инициализация проекта

```bash
mkdir my-mcp-server && cd my-mcp-server
npm init -y
npm install @modelcontextprotocol/sdk zod
npm install -D typescript @types/node
```

В `package.json` обязательно: `"type": "module"` (SDK использует ESM).

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

### Шаг 2: Минимальный сервер с одним tool

```typescript
// src/index.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'my-server',
  version: '1.0.0',
});

// Регистрация tool: имя, описание, zod-схема параметров, handler
server.tool(
  'hello',
  'Say hello to someone.',
  { name: z.string().describe('Name to greet.') },
  async ({ name }) => ({
    content: [{ type: 'text', text: `Hello, ${name}!` }],
  }),
);

// Запуск: stdio транспорт (stdin/stdout)
const transport = new StdioServerTransport();
await server.connect(transport);
```

### Шаг 3: Сборка и тест

```bash
npx tsc                           # компиляция
node dist/index.js                # запуск (зависнет — ждёт JSON-RPC на stdin)
```

### Шаг 4: Регистрация в Claude Code

В файле `~/.claude.json` (глобально) или в `projects` секции (для конкретного проекта):

```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"]
    }
  }
}
```

После перезапуска Claude Code сервер появится в `/mcp` и tools станут доступны агенту.

### Шаг 5: Развитие

- Добавить больше tools — каждый `server.tool(...)` регистрирует новый инструмент
- Для сложной логики — вынести в отдельные модули и импортировать
- handler получает валидированные параметры (zod проверяет автоматически)
- handler возвращает `{ content: [{ type: 'text', text: '...' }] }` — строка JSON/текст

## Архитектура vault-index

```
.claude/mcp-server/
  package.json
  tsconfig.json
  index.json              <- персистентный индекс (в .gitignore)
  src/
    index.ts              — entry point: McpServer + stdio + регистрация tools
    types.ts              — интерфейсы NoteRecord, WikiLink, IndexData, LintIssue
    vault-index.ts        — класс VaultIndex: build, refresh, persist, query
    parser.ts             — парсинг .md: YAML frontmatter, теги, aliases, WikiLinks
    taxonomy.ts           — парсинг Tag_taxonomy.md -> Set<string>
    lint.ts               — логика lint (воспроизводит проверки lint-vault.sh)
    tools/
      vault-lint.ts
      vault-broken-links.ts
      vault-orphans.ts
      vault-duplicate-links.ts
      vault-query.ts
      vault-backlinks.ts
      vault-note-profile.ts
      vault-stats.ts
      vault-reindex.ts
  dist/                   <- скомпилированный JS (в .gitignore)
  node_modules/           <- зависимости (в .gitignore)
```

### Ключевой паттерн: tool = тонкий handler + общий индекс

Каждый tool — отдельный файл с функцией `register*Tool(server, index)`. Handler получает уже готовый `VaultIndex`, вызывает `index.ensureFresh()`, делает запрос к индексу, форматирует результат. Вся тяжёлая логика — в `VaultIndex` и `parser.ts`.

Пример (`tools/vault-orphans.ts`, упрощённо):

```typescript
server.tool('vault_orphans', 'Find notes with zero incoming links.', { folder: z.string().optional() },
  async ({ folder }) => {
    await index.ensureFresh();
    const orphans = [];
    for (const record of index.allNotes()) {
      if (folder && !record.path.startsWith(folder)) continue;
      if (index.getBacklinks(record.name).size === 0) {
        orphans.push({ file: record.path, type: record.type, domain: record.domain });
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify({ orphans, count: orphans.length }) }] };
  },
);
```

## Персистентный индекс

**Формат**: JSON-файл `.claude/mcp-server/index.json` (<100KB для ~100 файлов).

**Содержимое**: массив записей NoteRecord + метаданные (версия схемы, timestamp сборки).

**Что хранится для каждого файла:**
- path, name (без .md), mtime
- frontmatter: type, domain, stability, priority, note_kind, co_authored, quality, created, updated
- tags[], aliases[]
- extra — специализированные поля (model_name, vendor, benchmark_category и т.д.)
- outgoingLinks[] — target, displayText, line number
- lines (количество строк)

**Производные структуры** (строятся в памяти из записей, не хранятся в JSON):
- `backlinks: Map<target, Set<source>>` — обратный индекс ссылок
- `aliasToName: Map<alias, canonicalName>` — маппинг алиасов
- `canonicalTags: Set<string>` — из [[Tag_taxonomy]]

**Расширяемость**: чтобы добавить новое поле (например, количество символов), достаточно: (1) добавить поле в `NoteRecord` в types.ts, (2) заполнять его в `parser.ts`, (3) бампнуть `INDEX_VERSION` — старый индекс автоматически пересоберётся.

## Жизненный цикл

```
Старт сервера
  |
  v
index.json существует?
  |-- Да -> загрузить записи, построить backlinks/aliases/tags
  \-- Нет -> полная сборка: readdir -> parse all -> save index.json
  |
  v
Вызов любого tool
  |
  v
ensureFresh()
  |-- readdir + stat всех .md файлов (~10ms)
  |-- mtime изменился? -> перепарсить файл, обновить backlinks
  |-- новый файл? -> добавить
  |-- файл удален? -> убрать
  \-- были изменения? -> сохранить index.json
  |
  v
Выполнить tool handler (запрос к индексу в памяти)
```

mtime обновляется при записи через любой инструмент (Obsidian, Claude Code, VS Code, скрипты) — это свойство файловой системы, не привязанное к конкретному редактору.

## 9 MCP-tools

### Замена скриптов (1-4)

| Tool | Заменяет | Input | Output |
|------|----------|-------|--------|
| `vault_lint` | lint-vault.sh | `{ target?, showAll? }` | `{ files: [...], summary }` |
| `vault_broken_links` | find-broken-links.sh | `{ folder? }` | `{ broken: [{ file, line, target }] }` |
| `vault_orphans` | find-orphans.sh | `{ folder? }` | `{ orphans: [{ file, type, domain }] }` |
| `vault_duplicate_links` | find-duplicate-links.sh | `{ folder? }` | `{ duplicates: [{ file, target, count }] }` |

### Новые возможности (5-9)

| Tool | Input | Output |
|------|-------|--------|
| `vault_query` | `{ type?, domain?, tags?, quality?, noteKind?, folder? }` | `{ notes: [...] }` |
| `vault_backlinks` | `{ note }` | `{ backlinks: [{ source, line }] }` |
| `vault_note_profile` | `{ note }` | `{ record + backlinks + lint issues }` |
| `vault_stats` | `{}` | `{ totals, by_type, by_domain, ... }` |
| `vault_reindex` | `{ full? }` | `{ indexed, timeMs, changes }` |
| `vault_lookalike_peers` | `{ note }` | `{ peers: [{file, name, edibility, listed_in_subject}], unlisted_in_subject }` |

## Запуск MCP-сервера у себя

Если vault передан как архив и нужно поднять MCP-сервер на другой машине.

### Требования

- Node.js >= 20 (`node --version`)
- npm (идёт с Node.js)
- Claude Code (CLI или Desktop app)

### Установка

```bash
cd <путь-к-vault>/.claude/mcp-server
npm install          # установить зависимости
npm run build        # скомпилировать TypeScript -> dist/
```

### Регистрация в Claude Code

Открыть файл `~/.claude.json` и добавить в секцию `mcpServers` (глобально) или в `projects.<путь>.mcpServers` (для конкретного проекта):

```json
"vault-index": {
  "type": "stdio",
  "command": "node",
  "args": ["<абсолютный-путь-к-vault>/.claude/mcp-server/dist/index.js"],
  "env": { "VAULT_ROOT": "<абсолютный-путь-к-vault>" }
}
```

`VAULT_ROOT` — абсолютный путь к корню vault. Обратные слэши на Windows экранировать: `D:\\My\\Vault`.

### Проверка

1. Перезапустить Claude Code
2. Набрать `/mcp` — должен появиться `vault-index · connected`
3. Попросить агента: «запусти vault_stats» — должна вернуться статистика

При первом вызове любого tool индекс построится с нуля (index.json). Последующие вызовы используют кеш и обновляют только изменённые файлы.

### Устранение проблем

| Симптом | Причина | Решение |
|---------|---------|---------|
| Сервер не появляется в `/mcp` | Ошибка в JSON или не тот путь | Проверить `~/.claude.json` через `node -e "JSON.parse(require('fs').readFileSync(...))"` |
| `MODULE_NOT_FOUND` | Не собран или не установлены зависимости | `npm install && npm run build` |
| Неверные результаты | Устаревший index.json | Вызвать `vault_reindex` с `full: true` |
| Новый файл не виден | Сервер ещё не обновил индекс | Любой вызов tool автоматически подхватит — ensureFresh() проверяет mtime |

## Верификация

Кросс-валидация с bash-скриптами:
1. `vault_lint` vs `lint-vault.sh --all` — одинаковые issues
2. `vault_broken_links` vs `find-broken-links.sh` — одинаковые результаты
3. `vault_orphans` vs `find-orphans.sh` — одинаковые orphans
4. `vault_duplicate_links` vs `find-duplicate-links.sh` — одинаковые дубликаты (MCP нашёл 1 дополнительный реальный дубликат)

Производительность: полная индексация ~100 файлов — <100ms, инкрементальный refresh — <50ms.
