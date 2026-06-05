---
type: guide
domain: system
stability: stable
priority: high
tags:
  - metadata
  - schema
---

# Схема метаданных (YAML Frontmatter)

## Определение

Это блок в самом начале каждого `.md`-файла, содержащий структурированную информацию о заметке. Всегда начинается и заканчивается тремя дефисами `---`.

## Почему это важно

- LLM-агенты могут понять что это за файл, не читая весь текст.
- Заметки находятся через поиск, плагин Dataview, MCP-tools `vault_query`.
- Позволяет автоматически фильтровать файлы при индексации (например, RAG берёт только `quality: verified`).
- Делает базу знаний похожей на базу данных.

## Основные поля (обязательно использовать)

**type** — какой вид заметки.

Базовый набор значений (расширяй под свой волт):
- `concept` — понятие, определение
- `rule` — правило, принцип
- `pattern` — шаблон, паттерн
- `guide` — инструкция, руководство
- `project` — описание проекта
- `reference` — справочная карточка

**domain** — тематическая область волта.

Значения волт-специфичные. Примеры: `system`, `tech`, `home`, `health`, `finance`. Полный список фиксируй ниже под заголовком «Домены этого волта».

**stability** — насколько информация проверена.
- `stable` — можно доверять, почти не меняется.
- `evolving` — развивается, может измениться.
- `experimental` — сырая идея, эксперимент.

**priority** — насколько важно для тебя сейчас.
- `high` — критично, часто используешь.
- `medium` — полезно.
- `low` — можно почитать, но не срочно.

**tags** — дополнительные метки (можно несколько).

```yaml
tags: [keyword-1, keyword-2]
```

См. [[Tag_taxonomy]] для каноничного набора и правил.

**note_kind** — уточнение типа заметки для автоматических правил (линковка, аудит, тематические скиллы).

Значения волт-специфичные. Поле опциональное — если не указано, применяются только правила по `type`. Расширения под свои `note_kind` — в этом файле, в секции «Поля по `note_kind`».

- `anime` — карточка аниме-тайтла (`ANIME/`)
- `person` — карточка человека из аниме-индустрии: режиссёр, сценарист, композитор, продюсер и т.д. (`PERSONS/`)
- `character` — карточка вымышленного персонажа аниме/манги (`CHARACTERS/`)
- `studio` — карточка анимационной студии-производителя (`STUDIOS/`)
- `manga` — карточка манги/произведения (`MANGA/`)

## Дополнительные поля (рекомендуемые)

**aliases** — альтернативные названия заметки (для поиска в Obsidian).

```yaml
aliases: [Альтернативное название]
```

**created** — дата создания заметки (формат `YYYY-MM-DD`).

**updated** — дата последнего обновления (формат `YYYY-MM-DD`).

**co_authored** — модель-автор **сути** карточки в origin (например `claude-opus-4.8`). Ставится только **производящими** контент скиллами (`/new-*`, `/expand-stub`, `/vault-rag`). **Аудиты это поле НЕ трогают** (`/audit-note`, `/audit-by-creator`, `/audit-review` — судьи, не авторы): перезапись на судью уничтожила бы субъект оценки качества модели (леджер `SYSTEM/model_quality.jsonl`) — правка Opus'ом косяков слабой модели не делает Opus автором карточки. След судьи живёт в `ledger.judge_model`. Значение — человекочитаемый origin как есть; **здесь не нормализуется** (канонизация ID для агрегатов — на стороне писателя леджера, см. `.claude/skills/audit-by-creator/references/ledger-protocol.md §3.1`/§6). См. [[feedback_co_authored]].

**quality** — статус проверки качества:
- `verified` — проверено, качество устраивает.
- `draft` — черновик, не проверено.

## USER-ONLY поля личной оценки — always-present с `null`

Любое поле субъективной оценки (`personal_score`, `art_score`/`story_score`/`originality_score`, `opening_score`/`ending_score`, личные статусы просмотра/чтения) рендерится во frontmatter **всегда**, по умолчанию `null`, и **не удаляется** при создании, даже если пустое. Причина: (1) **queryability** — выборки `WHERE art_score >= 8` и «непроставленные = null» работают, только если поле существует во всех карточках; (2) **анти-silent-drop** — пустой слот это явная инструкция, а не «можно опустить» (слабые модели роняют optional-поля). Модель такие поля **не заполняет** — субъективные данные пользователя, как `co_authored`. Скиллы создания (`/new-*`) рендерят их пустыми; `/audit-review` извлекает значения из прозы «## Личный отзыв» по явному запросу пользователя.

## Домены этого волта

> Заполни список доменов, которые используешь. Это уменьшит количество одноразовых неконсистентных значений.

| Домен | Описание |
| --- | --- |
| `system` | Мета-документы о самом волте |
| `anime` | Аниме-тематика: персонажи, тайтлы, студии, персоны индустрии |

## Поля по `note_kind`

> Здесь описываются дополнительные поля, обязательные для конкретных `note_kind`. Скиллы (`/new-note`, `/audit-note`, `/expand-stub`) читают эту секцию и применяют правила.

### Шаблон

```markdown
### note_kind: <твой_kind>

Все поля ниже **обязательны** для `note_kind: <kind>`, если не указано иное.

**field_name** — описание поля.

\`\`\`yaml
field_name: "значение"
\`\`\`

Допустимые значения: `value-1`, `value-2`.
```

> Заполни эту секцию по мере появления тематических `note_kind` в твоём волте.

## Поля для карточек Аниме (`note_kind: anime`)

Все поля ниже **обязательны** для `note_kind: anime`, если не указано иное.

> **Допустимые значения enum-полей** этого kind — в `SYSTEM/enums.yaml::note_kinds.anime`. Этот раздел описывает **семантику** полей (что они значат, когда заполнять); множества значений — отдельный машинно-читаемый источник. Расхождение между этим документом и `enums.yaml` — баг, поправить синхронно.

**title_romaji** — главный заголовок в ромадзи (латинская транскрипция японского), служит основным идентификатором.

```yaml
title_romaji: "Kimetsu no Yaiba"
```

**title_original** — оригинальное название на японском (или другом языке оригинала).

```yaml
title_original: "鬼滅の刃"
```

**format** — формат тайтла. Допустимые значения — `enums.yaml::note_kinds.anime.format`.

```yaml
format: tv
```

**status** — статус выхода. Допустимые значения — `enums.yaml::note_kinds.anime.status`.

Семантика: `airing` (в эфире), `finished` (завершён), `upcoming` (анонсирован), `on-hiatus` (приостановлен), `cancelled` (отменён).

```yaml
status: finished
```

**episodes** — число эпизодов. Для movie/short — `1`. Если число неизвестно/не объявлено — `0`.

```yaml
episodes: 26
```

**year** — год премьеры.

```yaml
year: 2019
```

**genres** — список жанров. Допустимые значения — `enums.yaml::note_kinds.anime.genres`.

```yaml
genres:
  - action
  - supernatural
```

**personal_status** — личный статус по тайтлу. Допустимые значения — `enums.yaml::note_kinds.anime.personal_status`.

Семантика: `watching` (смотрю), `completed` (завершил), `on-hold` (отложил), `dropped` (бросил), `plan-to-watch` (в очереди), `favorite` (любимое — взаимоисключает `completed`: ставится вместо `completed`, когда тайтл завершён и владелец волта явно отнёс его к личным избранным).

**`favorite` ≠ высокая `personal_score`.** Это **независимые** оси. `personal_score` — формальная оценка качества; `favorite` — узкая curated-категория любимых работ, выбираемая субъективно. Тайтл с оценкой 10/10 может оставаться `completed`, если не вошёл в личный круг избранных. Скиллы (`/audit-review`, `/audit-note`, `/new-anime`) **не должны** предлагать автоматический перевод `completed → favorite` на основании высокого score — только при явном маркере в тексте отзыва или прямом запросе пользователя.

```yaml
personal_status: completed
```

**created**, **updated** — даты создания и обновления в формате `YYYY-MM-DD`.

### Рекомендуемые поля

**title_english** — английский официальный заголовок (рекомендуемое).

```yaml
title_english: "Demon Slayer: Kimetsu no Yaiba"
```

**season** — сезон премьеры (рекомендуемое). Допустимые значения — `enums.yaml::note_kinds.anime.season`.

```yaml
season: spring
```

**studio** — главная студия-производитель, имя файла карточки в `STUDIOS/` (рекомендуемое, single foreign-key).

```yaml
studio: "Ufotable"
```

**source** — первоисточник (рекомендуемое). Допустимые значения — `enums.yaml::note_kinds.anime.source`.

```yaml
source: manga
```

**episode_duration_minutes** — длительность одного эпизода в минутах (рекомендуемое).

```yaml
episode_duration_minutes: 24
```

**personal_score** — личная оценка по 10-балльной шкале (рекомендуемое).

```yaml
personal_score: 9
```

**opening_score**, **ending_score** — отдельные личные оценки опенинга и эндинга по 10-балльной шкале (рекомендуемые, always-present с `null`). Заполняются, **только** когда качество OP/ED хочется оценить независимо от тайтла в целом (например, опенинг сильнее самого сериала). По умолчанию — `null`; пустой слот остаётся во frontmatter, чтобы поле было discoverable. Это **независимые** оси от `personal_score`: высокий/низкий балл за OP/ED не обязан коррелировать с общей оценкой и не влияет на неё.

```yaml
opening_score: 10
ending_score: 7
```

**art_score**, **story_score**, **originality_score** — персональные оси оценки (1–10, рекомендуемые, always-present `null`, **USER-ONLY**): рисовка/анимация, сюжет/сценарий, оригинальность/экспериментальность. Разносят впечатление на измерения для выборок «что люблю». Независимы от `personal_score` (холистическая общая, не среднее из осей) и друг от друга. По умолчанию `null`; модель не заполняет (субъективная оценка пользователя). Общие с `manga`. Тип проперти в Obsidian — number.

```yaml
art_score: 9
story_score: 8
originality_score: 7
```

**content_rating** — возрастной рейтинг контента (рекомендуемое, always-present, default `sfw`). Допустимые значения — `enums.yaml::note_kinds.anime.content_rating` (`sfw`/`nsfw`/`explicit`). Модель-заполняемое: из AniList `isAdult` + жанров (hentai→explicit, ecchi→nsfw, иначе sfw). Ось фильтра для исключения adult из выборок/семантического индекса.

```yaml
content_rating: sfw
```

**times_watched** — общее число просмотров (рекомендуемое). Семантика: `1` = смотрел один раз, `3` = смотрел трижды (то есть «пересматривал два раза»). Для `personal_status: plan-to-watch` / `on-hold` / `dropped` — обычно `null` (поле not applicable). Для `completed` / `favorite` / `watching` — минимум `1`.

```yaml
times_watched: 3
```

**last_episode_watched** — номер последнего просмотренного эпизода (рекомендуемое, политика «always-present»).

Семантика по `personal_status`:
- `completed` / `favorite` → равно `episodes` (последний эпизод сериала).
- `watching` → текущий прогресс (на каком эпизоде сейчас).
- `on-hold` → эпизод, на котором сделана пауза.
- `dropped` → эпизод, на котором бросил.
- `plan-to-watch` → `null` (не начинал).

Для `format: movie` / `format: special` (где `episodes: 1`) — `1` для всех просмотренных статусов, `null` для `plan-to-watch`. Для длинных открытых сериалов (`episodes: 0` если кол-во не объявлено) — текущая зрительская позиция.

```yaml
last_episode_watched: 12
```

**watched_with** — список со-зрителей, с кем смотрел/пересматривал этот тайтл (рекомендуемое). Допустимые значения — `enums.yaml::note_kinds.anime.watched_with`.

Семантика валют: `wife` (с женой), `mom` (с мамой), `brother` (с братом). Множественный выбор — если разные просмотры были с разными людьми, перечислить всех. Если смотрел только в одиночку — оставить `[]` или опустить.

Расширение enum'а — через `/add-note-kind`-логику или ручной Edit `enums.yaml` (когда появится новый со-зритель, которого регулярно хочется фиксировать).

```yaml
watched_with:
  - wife
  - mom
```

**mal_score** — средняя оценка MyAnimeList (0.00–10.00, рекомендуемое).

```yaml
mal_score: 8.51
```

**shikimori_score** — средняя оценка Shikimori (0.00–10.00, рекомендуемое).

```yaml
shikimori_score: 8.67
```

**aliases** — альтернативные имена и локализации (рекомендуемое).

```yaml
aliases:
  - "Demon Slayer"
  - "Клинок, рассекающий демонов"
```

**related_titles** — сиквелы/приквелы/спинофы; имена файлов карточек в `ANIME/` (рекомендуемое).

```yaml
related_titles:
  - "Demon_Slayer_Mugen_Train"
  - "Demon_Slayer_Entertainment_District"
```

**staff** — производственная команда; список словарей `{person, role}`, где `person` — имя файла карточки в `PERSONS/`, `role` — значение из `enums.yaml::note_kinds.anime.staff_role` (рекомендуемое).

Один человек с несколькими ролями (`Hayao Miyazaki` = режиссёр + сценарист) — две записи. Это сделано осознанно: позволяет точечно фильтровать по роли.

```yaml
staff:
  - person: "Hayao_Miyazaki"
    role: director
  - person: "Hayao_Miyazaki"
    role: screenwriter
  - person: "Joe_Hisaishi"
    role: composer
  - person: "Isao_Takahata"
    role: producer
```

**mal_url** — ссылка на страницу тайтла в MyAnimeList (рекомендуемое).

```yaml
mal_url: "https://myanimelist.net/anime/38000"
```

**manga_source** — манга-первоисточник(и), которые этот тайтл экранизирует; имена файлов карточек в `MANGA/` (рекомендуемое, реверс к `manga.anime_adaptation`). Заполнять, когда `source: manga` и карточка манги есть в волте. Реципрокно: `тайтл ∈ manga.anime_adaptation ⟺ манга ∈ anime.manga_source` (пара в `reciprocity_pairs`, ERROR).

```yaml
manga_source:
  - "Berserk"
```

**online_url** — персональная ссылка, где владелец волта **смотрит тайтл онлайн** (стриминг/плеер). **USER-ONLY** (заполняет пользователь, не модель). В отличие от `mal_url`/`anilist_url`/`shikimori_score` — это не каталожная справочная ссылка, а конкретный источник просмотра. Общее поле с `manga` (там — ссылка на ридер). Прогресс-поля (`last_episode_watched`) считаются в нумерации этого источника, если она расходится с официальной.

```yaml
online_url: "https://example-stream.tv/maria-sama"
```

## Поля для карточек Персон (`note_kind: person`)

Карточка человека из аниме-индустрии: режиссёр, сценарист, композитор, продюсер, аниматор, сэйю и т.п. Сэйю — `note_kind: person` с `roles: [voice-actor]` (см. семантику ниже); отдельного kind для них не существует.

Все поля ниже **обязательны** для `note_kind: person`, если не указано иное.

> **Допустимые значения enum-полей** этого kind — в `SYSTEM/enums.yaml::note_kinds.person`. Этот раздел описывает семантику; множества — машинно-читаемый источник отдельно.

**name_primary** — основной идентификатор. Для японцев — ромадзи (`Hayao Miyazaki`); для западных — имя в латинице как-есть. Совпадает с именем файла (с заменой пробелов на `_`).

```yaml
name_primary: "Hayao Miyazaki"
```

**name_native** — имя в родной письменности страны происхождения. Для японцев — кандзи/кана; для англоязычных — то же что primary; для русскоязычных — кириллица.

```yaml
name_native: "宮崎駿"
```

**roles** — основные профессиональные роли. Допустимые значения — `enums.yaml::note_kinds.person.role`. Superset `anime.staff_role`: все production-роли + `voice-actor`. Voice-actor намеренно вынесен из `anime.staff[]` (каст из 10–50 сэйю раздул бы staff[]; связь сэйю↔персонаж хранится через `works[].character` и `character.voice_actors[]`).

```yaml
roles:
  - director
  - screenwriter
  - mangaka
```

Для сэйю:

```yaml
roles:
  - voice-actor
```

Человек может иметь несколько ролей одновременно (актёр + режиссёр; mangaka + scenarist). Перечислять всё значимое.

**country** — страна происхождения / профессиональной деятельности.

```yaml
country: "Japan"
```

**birth_year** — год рождения.

```yaml
birth_year: 1941
```

**status** — жизненный статус. Допустимые значения — `enums.yaml::note_kinds.person.status`.

Семантика: `alive` (жив), `deceased` (умер).

```yaml
status: alive
```

**created**, **updated** — даты создания и обновления (`YYYY-MM-DD`).

### Рекомендуемые поля

**birth_date** — полная дата рождения, если известно с точностью до дня (рекомендуемое).

```yaml
birth_date: 1941-01-05
```

**death_date** — дата смерти (если `status: deceased`).

```yaml
death_date: 2020-12-08
```

**birth_place** — место рождения (город / регион / страна) (рекомендуемое).

```yaml
birth_place: "Tokyo, Japan"
```

**works** — список тайтлов, в которых человек участвовал, и его ролей в каждом. Поддерживается синхронно скиллом `/new-anime` (cross-update шаг 7.5: при создании аниме со `staff[]` для каждого person — добавляется/обновляется запись здесь).

```yaml
works:
  - title: "Nausicaa_of_the_Valley_of_the_Wind"
    roles: [director, screenwriter]
  - title: "Spirited_Away"
    roles: [director, screenwriter]
```

`title` — имя файла карточки в `ANIME/` **или `MANGA/`** (foreign key). `roles` — list[enum] из `enums.yaml::note_kinds.person.role`. Для манга-работ роль — `mangaka` / `novelist`; такая запись реципрокна `manga.authors[]` (пары `[manga, person]`/`[person, manga]` в `reciprocity_pairs`), материализуется в `## Ключевые работы` персоны наравне с аниме-работами.

**Для роли `voice-actor`** — запись расширяется обязательным ключом `character` (foreign-key в `CHARACTERS/`), потому что VA-роль определяется не только тайтлом, но и конкретным персонажем. Один сэйю может озвучивать разных персонажей в разных тайтлах, и одного персонажа в одном сезоне, но не в другом (если кастинг сменился) — поэтому каждая комбинация title+character — отдельная запись в `works[]`.

```yaml
works:
  - title: "Maria-sama_ga_Miteru"
    roles: [voice-actor]
    character: "Fukuzawa_Yumi"
  - title: "Maria-sama_ga_Miteru_Haru"
    roles: [voice-actor]
    character: "Fukuzawa_Yumi"
  - title: "Other_Anime"
    roles: [voice-actor]
    character: "Different_Character"
```

Запись с `roles: [voice-actor]` **без** `character` — невалидна. Запись с `character` **без** `voice-actor` в `roles[]` — тоже невалидна (поле имеет смысл только для VA-роли). Смешивать VA и production-роли в одной записи нельзя: если человек был и режиссёром, и VA одного тайтла — это две отдельные записи в `works[]` (первая `roles: [director]`, без `character`; вторая `roles: [voice-actor], character: X`).

**Source-якорь.** То же правило, что для `character.featured_in` (см. выше): каждая запись `works[]` — подтверждённый факт участия из прямого web fetch, не из памяти/snippet. Иерархия с fallback: **MAL** (`myanimelist.net/people/<id>` или каст/staff тайтла) → **AniList** (`anilist.co/staff/<id>`, GraphQL `Staff.staffMedia` / `Media.staff` / `Media.characters` для VA) → **Wikipedia/ANN**. Достаточно одного подтверждения; ни один источник не подтвердил → запись не добавлять + флаг; источники противоречат → флаг. Для VA-роли подтверждается пара `title`+`character` (каст тайтла на MAL/AniList).

Симметричная запись на стороне персонажа — `character.voice_actors[]` (см. секцию персонажей ниже). Mutual maintenance: при добавлении VA-записи в `works[]` через `/new-person` — добавляется зеркальная запись в `voice_actors[]` соответствующей карточки персонажа; при создании `/new-character` — forward-check по `PERSONS/*.md::works[]` подтягивает уже существующие VA-связи.

**aliases** — альтернативные написания, фан-сокращения, псевдонимы (рекомендуемое).

```yaml
aliases:
  - "Хаяо Миядзаки"
  - "Miyazaki Hayao"
```

**mal_url**, **anilist_url**, **wikipedia_url** — ссылки на внешние источники (рекомендуемое).

```yaml
mal_url: "https://myanimelist.net/people/1870/Hayao_Miyazaki"
anilist_url: "https://anilist.co/staff/96878/Hayao-Miyazaki"
wikipedia_url: "https://en.wikipedia.org/wiki/Hayao_Miyazaki"
```

## Поля для карточек Персонажей (`note_kind: character`)

Карточка вымышленного персонажа аниме или манги. Сэйю в этом kind не описываются (для них — `note_kind: person` с `roles: [voice-actor]`); здесь только сам нарративный персонаж, связь персонаж↔сэйю — через поле `voice_actors[]` (см. ниже).

Все поля ниже **обязательны** для `note_kind: character`, если не указано иное.

> **Допустимые значения enum-полей** этого kind — в `SYSTEM/enums.yaml::note_kinds.character`. Этот раздел описывает семантику; множества значений — машинно-читаемый источник отдельно. Расхождение между этим документом и `enums.yaml` — баг, поправить синхронно.

**name_romaji** — главный идентификатор. Для японских персонажей — ромадзи в каноничном порядке источника (для японских — обычно фамилия→имя: `Kamado Tanjiro`). Совпадает с именем файла (с заменой пробелов на `_`).

```yaml
name_romaji: "Kamado Tanjiro"
```

**name_native** — имя в родной письменности оригинала. Для японских — кандзи/кана; для западных персонажей — латиница; для русскоязычных — кириллица.

```yaml
name_native: "竈門炭治郎"
```

**featured_in** — тайтлы/произведения, в которых персонаж появляется в каноне. Имена файлов карточек в `ANIME/` **или `MANGA/`** (foreign keys, оба носителя — карточка персонажа единая на все носители, см. canon-policy). Список — потому что персонаж может появляться в сиквелах/спиноффах и в разных носителях (аниме + манга-первоисточник).

```yaml
featured_in:
  - "Demon_Slayer"
  - "Demon_Slayer_Mugen_Train"
```

**Source-якорь (КРИТИЧНО).** `featured_in` — не «по памяти», а **проверяемый факт**. Каждый тайтл в списке обязан быть подтверждён прямым web fetch авторитетной страницы (что персонаж реально появляется в этом тайтле). Инвариант: `тайтл ∈ featured_in(C) ⟺ C присутствует в касте этого тайтла на источнике`.

Иерархия источников (fallback при недоступности/отсутствии — MAL может лежать, не найти, отдать 403):
1. **MAL** — Animeography на странице персонажа (`myanimelist.net/character/<id>`) или каст тайтла (`<mal_url>/characters`).
2. **AniList** — `anilist.co/character/<id>` (поле `media`) либо GraphQL `Character.media` / `Media.characters`.
3. **Wikipedia / Fandom** тайтла — список/таблица персонажей, последний рубеж.

Правила:
- Достаточно **одного** авторитетного подтверждения, чтобы тайтл попал в `featured_in`.
- **Ни один источник не доступен / не находит** → тайтл **не добавлять** (консервативно), пометить в отчёте. Догадка/snippet/память — запрещены (тот же принцип, что для числовых полей, см. `feedback_numeric_facts_from_fetch`).
- Источники **противоречат** по факту присутствия (один числит, другой нет) → не решать молча, флагать на ручную проверку.

Это якорь всей реципрокности character↔anime: `/new-anime` тиражирует `featured_in` в обратную сторону, а consistency-машинерия **верно разносит то, что здесь записано** — поэтому ошибка тут размножается, а не гасится (кейс Mizuno→3rd: поле врало, поймал только MAL). Проверяется при создании (`/new-character`, `/new-anime`) и ре-сверяется аудитом (`Audit_checklist.md` 4.6).

**character_role** — нарративная роль в произведении. Поле специально называется `character_role`, чтобы не путаться с `anime.staff[].role` и `person.roles` (там — производственные роли). Допустимые значения — `enums.yaml::note_kinds.character.character_role`.

Семантика: `protagonist` (главный герой), `deuteragonist` (второй главный), `antagonist` (главный противник), `supporting` (значимый второстепенный), `minor` (эпизодический). Если персонаж играет разные роли в разных тайтлах — фиксировать ту, что доминирует в основном произведении.

```yaml
character_role: protagonist
```

**gender** — пол. Допустимые значения — `enums.yaml::note_kinds.character.gender`.

Семантика: `male` / `female` / `non-binary` (явно небинарный по канону) / `other` (специфические случаи — гермафродиты, ИИ, негуманоиды без определимого пола) / `unknown` (по канону не определено).

```yaml
gender: male
```

**status** — статус по итогам канонического произведения. Допустимые значения — `enums.yaml::note_kinds.character.status`.

Семантика: `alive` (жив на конец канона), `deceased` (умер по канону), `unknown` (судьба не определена). Семантика отличается от `person.status` (там — жизненный статус реального человека) и от `anime.status` (там — статус выхода тайтла).

```yaml
status: alive
```

**created**, **updated** — даты создания и обновления (`YYYY-MM-DD`).

### Рекомендуемые поля

**name_english** — английское/локализованное имя, под которым персонаж известен западной аудитории (рекомендуемое).

```yaml
name_english: "Tanjiro Kamado"
```

**aliases** — альтернативные написания: русская локализация, никнеймы из канона, иные транслитерации (рекомендуемое).

```yaml
aliases:
  - "Танджиро Камадо"
  - "Tanjirou Kamado"
```

**age** — возраст. Строка, поскольку часто это диапазон по ходу сюжета (`13-16`) или нечеткое значение (`"1000+"`, `"unknown"`).

```yaml
age: "13-16"
```

**species** — раса/вид. Свободная строка, поскольку фэнтези/сай-фай-домены порождают слишком большое разнообразие (`human`, `demon`, `ayakashi`, `elf`, `alien`, `cyborg` и т.д.).

```yaml
species: "human"
```

**affiliations** — принадлежность к организациям, фракциям, кланам, семьям. Свободные строки — фракции редко имеют собственные карточки.

```yaml
affiliations:
  - "Корпус истребителей демонов"
  - "Семья Камадо"
```

**personal_score** — личная оценка персонажа по 10-балльной шкале (рекомендуемое, **always-present `null`**, **USER-ONLY**). Рендерится во frontmatter **всегда** (по умолчанию `null`), не удаляется при создании, даже если персонаж не отмечен как любимый — иначе по полю нельзя сделать выборку и слабые модели его молча роняют (см. общий принцип «USER-ONLY поля личной оценки» выше). Заполняет пользователь, не модель. Тип проперти — number.

```yaml
personal_score: null
```

**voice_actors** — список сэйю, озвучивавших персонажа, привязанный к конкретным тайтлам (рекомендуемое). Список словарей `{anime, person}`, где `anime` — имя файла карточки в `ANIME/`, `person` — имя файла карточки сэйю в `PERSONS/`.

Семантика: каждая запись фиксирует, какой сэйю озвучивал персонажа в каком тайтле. Один и тот же сэйю в нескольких тайтлах — несколько записей (по одной на тайтл). Если в каком-то сезоне сэйю сменился — это другая `person` в записи на этот anime. Если у персонажа нет VA (манга-only до экранизации) — `[]`.

```yaml
voice_actors:
  - anime: "Maria-sama_ga_Miteru"
    person: "Kana_Ueda"
  - anime: "Maria-sama_ga_Miteru_Haru"
    person: "Kana_Ueda"
```

Симметричное поле — `person.works[]` с `roles: [voice-actor]` и `character: <this character>`. Mutual maintenance: при создании карточки сэйю через `/new-person` cross-update заполняет это поле; при создании `/new-character` forward-check по `PERSONS/*.md::works[]` находит уже существующие VA-связи и подтягивает их сюда. Тело карточки рендерит секцию `## Сэйю` в gallery-формате (миниатюра 60 + WikiLink) на основании этого поля.

**mal_url** — ссылка на профиль персонажа на MyAnimeList (рекомендуемое).

```yaml
mal_url: "https://myanimelist.net/character/146157/Tanjirou_Kamado"
```

**anilist_url** — ссылка на профиль персонажа на AniList (рекомендуемое).

```yaml
anilist_url: "https://anilist.co/character/126180/Tanjiro-Kamado"
```

**images** — словарь типизированных изображений. Минимум — `cover` (главный портрет). Соблюдает общую конвенцию волта: поле `cover`, файл `<File_Name>_cover.<ext>` — совпадает с тем, что использует `/add-images` и `anime`-карточки. Дополнительные ключи свободны на усмотрение (формы, превращения, ключевые арты), но в frontmatter поднимать только то, на что есть embed в теле.

```yaml
images:
  cover: "attachments/Kamado_Tanjiro_cover.jpg"
```

## Поля для карточек Студий (`note_kind: studio`)

Карточка анимационной студии-производителя аниме (MAPPA, Madhouse, Ufotable, Studio Ghibli, Topcraft и т.п.).

Все поля ниже **обязательны** для `note_kind: studio`, если не указано иное.

> **Допустимые значения enum-полей** этого kind — в `SYSTEM/enums.yaml::note_kinds.studio`. Этот раздел описывает семантику; множества значений — машинно-читаемый источник отдельно.

**name_primary** — основной идентификатор. Английское или ромадзи-имя. Совпадает с именем файла (с заменой пробелов на `_`).

```yaml
name_primary: "Ufotable"
```

**name_native** — имя в родной письменности страны базирования. Для японских студий — кандзи/кана; для западных — то же что primary.

```yaml
name_native: "ユーフォーテーブル有限会社"
```

**founded_year** — год основания студии (4 цифры).

```yaml
founded_year: 2000
```

**country** — страна базирования студии.

```yaml
country: "Japan"
```

**status** — статус деятельности студии. Допустимые значения — `enums.yaml::note_kinds.studio.status`.

Семантика: `active` (работает), `defunct` (закрыта/упразднена), `on-hiatus` (приостановлена, статус неопределённый).

Отличается от `anime.status` (статус выхода тайтла), `person.status` (жизненный статус человека), `character.status` (статус по итогам канона) — общее имя, разные домены.

```yaml
status: active
```

**created**, **updated** — даты создания и обновления (`YYYY-MM-DD`).

### Рекомендуемые поля

**aliases** — альтернативные написания: русская локализация, аббревиатуры, исторические имена (рекомендуемое).

```yaml
aliases:
  - "Уфотейбл"
  - "Ufotable Inc."
```

**headquarters** — город / район базирования (рекомендуемое).

```yaml
headquarters: "Kitashinjuku, Shinjuku, Tokyo"
```

**founders** — основатели студии (рекомендуемое). Список plain strings — если у основателя появится карточка в `PERSONS/`, имя можно превратить в WikiLink в теле, но во frontmatter оставляется как plain string (как `affiliations` у character).

```yaml
founders:
  - "Hikaru Kondō"
```

**parent_company** — материнская компания, если студия — подразделение более крупного холдинга (например, Sunrise → Bandai Namco) (рекомендуемое).

```yaml
parent_company: "Bandai Namco Filmworks"
```

**successor** — преемник для упразднённых студий: кто фактически продолжил традицию (Topcraft → Studio Ghibli). Заполнять только при `status: defunct` (рекомендуемое).

```yaml
successor: "Studio Ghibli"
```

**website** — официальный сайт студии (рекомендуемое).

```yaml
website: "https://www.ufotable.com"
```

**wikipedia_url** — ссылка на статью в Wikipedia (рекомендуемое).

```yaml
wikipedia_url: "https://en.wikipedia.org/wiki/Ufotable"
```

**mal_url** — ссылка на страницу студии-продюсера на MyAnimeList (`https://myanimelist.net/anime/producer/<id>`) (рекомендуемое).

```yaml
mal_url: "https://myanimelist.net/anime/producer/43/ufotable"
```

**images** — словарь изображений студии. Минимум — `cover` (логотип/баннер). Та же конвенция, что у всех остальных kind: файл `<File_Name>_cover.<ext>`, совместим с `/add-images`.

```yaml
images:
  cover: "attachments/Ufotable_cover.png"
```

## Поля для карточек Манги (`note_kind: manga`)

Карточка манги — это **произведение (серия)**, а не конкретный том/издание. **Edition-level** поля (`isbn`, число страниц конкретного тома, издатель **локализованного** издания — напр. TOKYOPOP для немецкого) намеренно отсутствуют: единица учёта — произведение, как и у `anime`-тайтла. При этом **оригинальный издатель** (Shueisha, Kodansha и т.п.) — это work-level производственная сущность, прямой аналог `studio` у аниме, и он **присутствует** как поле `publisher` (см. ниже); не путать с edition-publisher локализации.

Все поля ниже **обязательны** для `note_kind: manga`, если не указано иное.

> **Допустимые значения enum-полей** этого kind — в `SYSTEM/enums.yaml::note_kinds.manga`. Этот раздел описывает семантику; множества значений — машинно-читаемый источник отдельно.

**title_romaji** — главный заголовок в ромадзи, основной идентификатор.

```yaml
title_romaji: "Berserk"
```

**title_original** — оригинальное название (японский/язык оригинала).

```yaml
title_original: "ベルセルク"
```

**tradition** — носитель/традиция (origin). Допустимые значения — `enums.yaml::note_kinds.manga.tradition`. `manga`-kind зонтичный для всех рисованных носителей: `manga` (JP), `manhwa` (KR), `manhua` (CN), `rumanga` (RU), `comic` (западные/прочее). Origin-ось, не формат (постранично/вебтун-скролл не различаем).

```yaml
tradition: manga
```

**status** — статус публикации. Допустимые значения — `enums.yaml::note_kinds.manga.status`.

Семантика: `publishing` (выходит), `finished` (завершена), `on-hiatus` (на паузе), `discontinued` (заброшена/прекращена), `upcoming` (анонсирована).

```yaml
status: publishing
```

**volumes** — число выпущенных томов. `0`, если онгоинг и финальное число неизвестно.

```yaml
volumes: 41
```

**chapters** — число глав. `0`, если неизвестно/не считается.

```yaml
chapters: 0
```

**year** — год начала публикации.

```yaml
year: 1989
```

**demographic** — демографическая категория журнала-публикатора. Допустимые значения — `enums.yaml::note_kinds.manga.demographic`. Manga-специфика, у `anime` поля нет.

Семантика: `shounen` (юноши), `seinen` (взрослые мужчины), `shoujo` (девушки), `josei` (взрослые женщины), `kodomo` (дети), `none` (додзинси/веб-манга вне журнальной демографики).

```yaml
demographic: seinen
```

**genres** — список жанров. Допустимые значения — `enums.yaml::note_kinds.manga.genres` (общий набор с `anime`).

```yaml
genres:
  - action
  - fantasy
  - horror
```

**personal_status** — личный статус чтения. Допустимые значения — `enums.yaml::note_kinds.manga.personal_status`. **USER-ONLY** — заполняет владелец волта, не модель.

Семантика: `reading`, `completed`, `on-hold`, `dropped`, `plan-to-read`, `favorite` (взаимоисключает `completed`, как у `anime`).

```yaml
personal_status: reading
```

### Рекомендуемые поля

**title_english** — английский официальный заголовок.

```yaml
title_english: "Berserk"
```

**authors** — авторы произведения; список словарей `{person, role}`, где `person` — имя файла карточки в `PERSONS/` (роль `mangaka`/`novelist`), `role` — из `enums.yaml::note_kinds.manga.author_role` (`story` / `art` / `story-and-art`). Раздельные сценарист (原作) и художник (作画) — две записи. Один автор и пишет, и рисует — одна запись `story-and-art`. **Реципрокно с `person.works[]`** (зеркало `anime.staff[]↔person.works[]`): автор с карточкой в `PERSONS/` получает обратную запись `{title: <манга>, roles: [mangaka|novelist]}` + строку в своей секции `## Ключевые работы`. Пары `[manga, person]`/`[person, manga]` в `reciprocity_pairs` (ERROR).

```yaml
authors:
  - person: "Kentaro_Miura"
    role: story-and-art
```

**serialized_in** — журнал-публикатор (свободная строка — журналы редко имеют карточки).

```yaml
serialized_in: "Young Animal"
```

**publisher** — **оригинальный** издатель произведения (Shueisha, Kodansha, Shogakukan и т.п.). Work-level производственная сущность, прямой аналог `studio` у аниме. Пока **свободная строка** (имя издателя); при появлении note_kind `PUBLISHERS/` станет FK на карточку (зеркало `anime.studio↔STUDIOS/`). Не путать с издателем локализованного издания (edition-level, не храним).

```yaml
publisher: "Shueisha"
```

**related_titles** — связанные манги франшизы (сиквелы/приквелы/спиноффы); имена файлов карточек в `MANGA/`.

```yaml
related_titles: []
```

**anime_adaptation** — аниме-экранизации этой манги; имена файлов карточек в `ANIME/`. Реверс к `anime.manga_source`. Реципрокно (пара в `reciprocity_pairs`, ERROR).

```yaml
anime_adaptation:
  - "Berserk_1997"
```

**mal_score** — средняя оценка MyAnimeList (0.00–10.00).

```yaml
mal_score: 9.46
```

**mal_url**, **anilist_url** — ссылки на внешние источники.

```yaml
mal_url: "https://myanimelist.net/manga/2"
anilist_url: "https://anilist.co/manga/30002"
```

**online_url** — персональная ссылка, где владелец волта **читает мангу онлайн** (сканлейт/легальный ридер). **USER-ONLY** (заполняет пользователь, не модель). В отличие от `mal_url`/`anilist_url` — это не каталожная справка, а конкретный источник чтения. Общее поле с `anime` (там — стриминг). Задаёт контекст нумерации для `last_chapter_read` (см. оговорку у поля).

```yaml
online_url: "https://v2.shlib.life/ru/manga/14334--maria-sama-ga-miteru"
```

**personal_score** — личная оценка (1–10). **USER-ONLY**.

**times_read** — сколько раз прочитана. **USER-ONLY**.

**last_chapter_read** — номер последней прочитанной главы (прогресс чтения). **USER-ONLY**. Считается в **нумерации источника, где пользователь читает** (`online_url`): сканлейт-ридеры часто дробят/перенумеровывают главы (журнальные выпуски vs танкобонные главы, отдельные омаке/доп-истории) и могут расходиться с официальным `chapters` (танкобонным счётом). При расхождении — `chapters` держит официальное число, `last_chapter_read` — в шкале своего ридера.

**art_score**, **story_score**, **originality_score** — персональные оси оценки (1–10, always-present `null`, **USER-ONLY**): рисовка, сюжет, оригинальность/экспериментальность. Независимы от `personal_score` (холистическая общая) и друг от друга. Общие с `anime`. Модель не заполняет. Тип проперти в Obsidian — number.

```yaml
art_score: 9
story_score: 8
originality_score: 7
```

**translation_status** — статус **перевода** (НЕ оригинала — тот в `status`). Допустимые значения — `enums.yaml::note_kinds.manga.translation_status` (`complete`/`ongoing`/`abandoned`/`on-hold`/`none`). **User-filled** — модель не знает состояние перевода/скана на читательском сайте; default `null`, из веба не выводить.

```yaml
translation_status: ongoing
```

**coloring** — цветность. Допустимые значения — `enums.yaml::note_kinds.manga.coloring` (`black-and-white`/`full-color`/`partial`). Модель best-effort: webtoon/манхва/маньхуа обычно `full-color`, манга обычно `black-and-white`; сверять с источником.

```yaml
coloring: black-and-white
```

**content_rating** — возрастной рейтинг. Допустимые значения — `enums.yaml::note_kinds.manga.content_rating` (`sfw`/`nsfw`/`explicit`). Always-present, default `sfw`, модель-заполняемое (AniList isAdult + жанры). Ось фильтра adult-контента.

```yaml
content_rating: sfw
```

**images** — словарь изображений. Минимум — `cover` (обложка 1-го тома / ключевой арт). Конвенция как у всех kind: `<File_Name>_cover.<ext>`.

```yaml
images:
  cover: "attachments/Berserk_cover.jpg"
```
