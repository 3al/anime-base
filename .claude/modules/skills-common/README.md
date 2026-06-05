# skills-common

Модуль bootstrap-фреймворка, поставляющий **тема-нейтральные скиллы** в `.claude/skills/` нового волта.

## Скиллы в комплекте

| Скилл | Назначение |
|---|---|
| `fix-links` | Поиск и исправление сломанных WikiLinks, дубликатов, сирот, асимметрии |
| `audit-note` | Полный аудит заметки: lint + семантика + факт-чек + правки + оценка автора в леджер |
| `new-note` | Создание новой заметки с manifest-driven routing'ом по папкам |
| `rename-note` | Переименование/перемещение с обновлением WikiLinks по волту |
| `verify` | Пометить заметку как проверенную (`quality: verified`) |
| `expand-stub` | Расширить тонкую/пустую заметку до полноценной |
| `add-note-kind` | Добавить новый `note_kind` в волт (governance + генерация `/new-<kind>`) |
| `harness-agnostic-audit` | Привести скиллы/доки к кросс-харнес форме (Claude Code + Opencode) |
| `vision-gate-audit` | Ретрофит vision-gate в рукописные image-скиллы |
| `audit-by-creator` | Сверка карточки с её создающим скиллом + оценка качества модели-автора в леджер |

Тематические скиллы (например, `new-mushroom`, `fix-lookalikes` для грибного волта) **не входят** в этот модуль и не управляются фреймворком — они живут непосредственно в соответствующем волте.

## Managed маркеры

Каждый установленный скилл получает `.claude/skills/<name>/.managed`:
```json
{"module": "skills-common", "version": "0.1.0", "installed_at": "..."}
```

При повторном `/init-vault`:
- Скилл с `.managed` той же версии — no-op.
- Скилл с `.managed` старой версии — пересоздаётся.
- Скилл без `.managed` — **skip с warning'ом** («user-customized»).
- Отсутствующий — устанавливается заново.

Если хочется получить framework-версию вместо своей: удалить `.claude/skills/<name>/` руками и перезапустить `/init-vault`.

## Зависимости

- `core` (для CLAUDE.md outer block + governance-шаблонов в `SYSTEM/`).

## Контракт операций

- `install` — копирует скиллы, ставит `.managed`-маркеры, добавляет sub-block в CLAUDE.md.
- `status` — отчитывается per-skill (`managed_current` / `managed_outdated` / `unmanaged` / `missing`).

См. `Vault_Bootstrap_Architecture.md` → «Контракт операций».
