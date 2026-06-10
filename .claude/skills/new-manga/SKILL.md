---
name: new-manga
description: >
  Create a new manga card note (manga). Use when the user says
  /new-manga, "создай карточку манги", "новая манга",
  "добавь мангу", or wants to add a manga entry to the vault.
argument-hint: "<название манги> [--no-images]"
disable-model-invocation: false
model: opus
---

# /new-manga — Создание карточки манги

> [!important] Vision-gate (обязательно)
> Этот скилл работает с изображениями (обложка). Если передан флаг `--no-images` / `-n` — фото-шаг пропускается целиком (флаг не часть названия). Иначе перед скачиванием/подбором обложки пройди **Vision-gate** из `CLAUDE.md` → «Правила скачивания и валидации изображений»: **pre-flight probe ДО любого скачивания** — открой ассет `.claude/assets/vision_probe.png` (Read) и убедись, что реально видишь содержимое. Если модель не мультимодальна (Read дал ошибку/метаданные, не визуал) → **СТОП**, ноль скачиваний: не оценивай обложку по имени файла/URL, доделай карточку текстом или потребуй запуска с `--no-images`.

Создаёт карточку манги (произведения/серии) с заполнением всех обязательных полей frontmatter согласно `note_kind: manga` и каркасом тела заметки. Единица учёта — **произведение**, не конкретный том/издание.

## Аргумент

`$ARGUMENTS` — название манги на русском, английском или японском.

Флаг `--no-images` / `-n` (опционально) — пропустить весь фото-шаг (обложка): карточка создаётся без изображения. Осознанный обход vision-gate для не-мультимодальной модели.

Примеры:
- `/new-manga "Berserk"`
- `/new-manga Vinland Saga`
- `/new-manga Берсерк --no-images`

## Источники правил

Перед созданием прочитай:

1. **`SYSTEM/Metadata_schema.md`** — секция «Поля для карточек Манги (`note_kind: manga`)». Полный список обязательных и опциональных полей + семантика.
2. **`SYSTEM/enums.yaml`** — раздел `note_kinds.manga`. Машинно-читаемые множества (`status`, `demographic`, `personal_status`, `genres`, `author_role`). **Не подставлять значения вне enums.yaml.**
3. **`SYSTEM/Linking_guidelines.md`** — секция `### note_kind: manga`. Обязательные WikiLinks + взаимность с character/anime.
4. **`SYSTEM/Naming_conventions.md`** — формат имени файла.

## Алгоритм

### 1. Проверить существование

Найти файл через Glob в `MANGA/`. Если карточка уже существует:
- **Stub / тонкая (<20 строк контента)** — не создавать с нуля, а дополнить. Сохранить существующие данные.
- **Наполненная (>50 строк)** — сообщить пользователю. Спросить, что обновить.

### 2. Сбор данных

Найти актуальные данные через web search. Приоритет источников для манги:
- **MyAnimeList** (`myanimelist.net/manga/<id>`) — volumes, chapters, status, published dates, demographic, serialization (журнал), **оригинальный издатель** (`publisher`), authors, score.
- **AniList** (`anilist.co/manga/<id>`, GraphQL `Media(type:MANGA)`) — структурированные поля, staff (story/art), characters, relations (аниме-адаптации).
- **Fandom-вики произведения** — биография, арки, персонажи.
- **Wikipedia** — fallback для синопсиса и культурного контекста.

**Численные/перечисляемые факты — через прямой web fetch конкретной страницы**, не из snippet'а web search (см. `feedback_numeric_facts_from_fetch`). Для `mal_score`, `volumes`, `chapters`, `year` — конкретная страница на источнике; недоступна → поле пропустить, не угадывать.

**Персонажи и аниме-адаптации — собрать для реципрокности (шаг 7.5):**
- **Каст:** MAL `<mal_url>/characters` или AniList `Media.characters` — основные персонажи (Main + значимые Supporting). Для каждого — имя ромадзи + 1 строка роли.
- **Аниме-адаптации:** на MAL/AniList в разделе Relations связь «Adaptation» → тайтлы. Для каждого — имя.
- **Forward-check карточек:** Glob `CHARACTERS/<имя>.md`, `ANIME/<title>.md`, `PERSONS/<автор>.md`. Существующие — прочитать frontmatter, запомнить `images.cover` (для gallery-формата в теле).

**`anime_adaptation` и каст — source-anchored.** Каждая аниме-адаптация и каждый персонаж в карточке — подтверждённый факт из прямого fetch (Relations / characters на MAL/AniList), не из памяти. Это якорь реципрокности (тиражируется в шаге 7.5).

**Взрослый контент (`content_rating`).** Определить из источника: AniList `Media.isAdult` + жанры (`hentai`→`explicit`, `ecchi`→`nsfw`, иначе `sfw`). **MAL хентай прячет/режет — для adult основной источник AniList.** Синопсис и тело держать **неграфичными**: жанр/темы, без порнографической прозы. **Жёсткий предел:** никакого сексуального контента с участием несовершеннолетних/изображённых как несовершеннолетние. Adult-теги — из категории `Tag_taxonomy` «Контент-рейтинг / adult», только при `nsfw`/`explicit`; **категория наполняется при первом adult-тайтле** (теги — контент волта, как остальная таксономия) — если её ещё нет, завести по `tag-discipline`-критерию, а не выдумывать вне канона. Обложка adult — качать как обычно (шаг 6.5); не прошла визуальную политику → пометка в отчёте, пользователь добавит руками.

### 3. Определить имя файла

Формат: `PascalCase_With_Underscores.md`, только латиница, без диакритики. По умолчанию — `title_romaji` с заменой пробелов на `_`: `Berserk.md`, `Vinland_Saga.md`, `Vagabond.md`. Кириллица/японский — в `aliases`/`name_native`.

**Уникальность basename по всему волту (ОБЯЗАТЕЛЬНО).** Obsidian резолвит `[[WikiLink]]` по basename **без учёта папки** — манга с тем же именем, что у одноимённого аниме-тайтла (`Berserk` манга ↔ `Berserk` аниме) делает каждую ссылку неоднозначной и молча ломает граф. Поэтому:
1. Glob `**/<Имя>.md` по **всему волту**, не только по `MANGA/`.
2. Совпадений нет → имя свободно, продолжать.
3. Найдена заметка с таким basename (в любой папке) → **СТОП, не создавать молча**. Предложить пользователю дизамбигуированное имя структурированным multi-choice вопросом (по `SYSTEM/Naming_conventions.md` → «Глобальная уникальность basename»: уточняющий квалификатор, год, либо суффикс `_(manga)`). `title_romaji` сохраняет каноничную форму.

В `aliases`: английский официальный заголовок (если основное в ромадзи), кириллическая локализация/транслитерация, известные фан-сокращения.

### 4. Собрать frontmatter

**Прежде чем подставлять enum-значения** — прочитать `SYSTEM/enums.yaml::note_kinds.manga`, проверить каждое. Значение из web-research вне enum'а → не вписывать молча, структурированным multi-choice вопросом спросить (Добавить в enums.yaml / Пропустить / Заменить на существующее), как `/new-anime` шаг 4.

Заполнить ВСЕ обязательные поля для `note_kind: manga`:

```yaml
---
type: reference
domain: manga
stability: stable
priority: medium
quality: draft
note_kind: manga
tags:
  - <тематические теги по Tag_taxonomy>
aliases:
  - <английский заголовок / кириллица / фан-сокращение>
created: <сегодня в YYYY-MM-DD>
updated: <сегодня в YYYY-MM-DD>
title_romaji: "<Romaji-заголовок>"
title_original: "<日本語 / язык оригинала>"
title_cyrillic: "<Русское название: устоявшаяся локализация ИЛИ согласованный с пользователем перевод>"
status: <значение из enums.yaml::note_kinds.manga.status>
volumes: <число; 0 если онгоинг/финальное число неизвестно>
chapters: <число; 0 если неизвестно>
year: <YYYY — год начала публикации>
demographic: <значение из enums.yaml::note_kinds.manga.demographic>
tradition: <enums.yaml::note_kinds.manga.tradition — manga|manhwa|manhua|rumanga|comic>
content_rating: <enums...manga.content_rating; default sfw; model-fillable: AniList isAdult + жанры (hentai→explicit, ecchi→nsfw)>
coloring: <enums...manga.coloring; best-effort: webtoon/манхва/маньхуа→full-color, манга→black-and-white>
genres:
  - <значение из enums.yaml::note_kinds.manga.genres>
personal_status: <значение из enums.yaml::note_kinds.manga.personal_status>   # USER-ONLY — статус чтения
# Рекомендуемые (always-present; ненайденные оставить пустыми, USER-ONLY не выдумывать):
title_english: "<English или ''>"
authors:                       # list[dict] {person, role}, FK→PERSONS/; роль из enums.yaml::note_kinds.manga.author_role
  - person: "<Person_File>"
    role: story-and-art
serialized_in: "<журнал-публикатор или ''>"
publisher: "<оригинальный издатель — Shueisha/Kodansha/Shogakukan/... или ''>"   # work-level, аналог studio; пока свободная строка (kind PUBLISHERS/ нет)
related_titles: []             # FK→MANGA/ (франшиза)
anime_adaptation: []           # FK→ANIME/ (реверс anime.manga_source)
mal_score: <0.00-10.00 или null>
mal_url: "<https://myanimelist.net/manga/... или ''>"
anilist_url: "<https://anilist.co/manga/... или ''>"
translation_status:            # enums...manga.translation_status; USER-FILLED (модель не знает скан), default null
personal_score:                # опционально, USER-ONLY — личная оценка
art_score:                     # опционально, USER-ONLY — оценка рисовки (1-10)
story_score:                   # опционально, USER-ONLY — оценка сюжета (1-10)
originality_score:             # опционально, USER-ONLY — оригинальность/экспериментальность (1-10)
times_read:                    # опционально, USER-ONLY — сколько раз прочитана
last_chapter_read:             # опционально, USER-ONLY — прогресс чтения (в нумерации online_url; может расходиться с official chapters)
online_url:                    # опционально, USER-ONLY — ссылка на ридер, где читаешь онлайн; модель НЕ заполняет
images:
  cover: "attachments/<File_Name>_cover.<ext>"
---
```

**Соглашения по пустым значениям:** строки → `""`, числа → `null` (или `0` для volumes/chapters по семантике «неизвестно»), списки → `[]`, enum → `null`. `genres` — минимум 1 значение.

**`title_cyrillic` — обязательное кириллическое название (интерактивный резолв).** Есть **устоявшаяся** русская локализация (подтвердить web search: Shikimori, Wikipedia RU, легальные ридеры) → использовать её. Устоявшегося варианта **нет** → структурированным multi-choice вопросом предложить пользователю 2–3 варианта (дословный перевод `title_english` + транслитерация ромадзи кириллицей) и попросить выбрать либо вписать свой. **Молча не выдумывать** перевод — это решение пользователя (в отличие от персонажей/персон, где кириллизация однозначна). См. `SYSTEM/Metadata_schema.md` → `title_cyrillic`.

**НЕ ставить `co_authored` при создании** (см. `feedback_co_authored`). Проставляется через `/verify` или `/audit-note`.

**`USER-ONLY`-поля** (`personal_status`, `personal_score`, `art_score`, `story_score`, `originality_score`, `times_read`, `last_chapter_read`, `online_url`) — оставить **пустыми**, не выдумывать. Рендерятся всегда (discoverability), НЕ удаляются даже если пусты. **`translation_status`** — тоже user-filled (модель не знает состояние перевода/скана) → default пусто, из веба не выводить. **`content_rating`/`coloring`** — модель-заполняемые (см. шаг 2).

**Теги подбирать пошагово** (как `/new-note` шаг 6). У `note_kind: manga` **обязательных тегов нет** — категоризация закрыта полями (`demographic`, `genres`, `status`). Не дублировать enum-поля в теги. **Канон-дисциплина** (критерий D + правила: `.claude/skills/audit-by-creator/references/tag-discipline.md`): выбирать из канона `SYSTEM/tag_taxonomy.yaml`; новый тег — только по критерию D (переиспользуемая ось по природе, не франшизо/сущность-узкий ярлык), **структурной записью** в `tag_taxonomy.yaml` (не в md — генерируется), проставляя на все facet-сиблинги, не точечно.

### 5. Написать содержание

Каркас тела заметки:

```markdown
# <title_romaji> (<title_original>)

![[<File_Name>_cover.<ext>|300]]

**<Основное название>** — <1-2 предложения: жанр, демографика, завязка, чем значима>.

## Краткий синопсис

<1-2 абзаца: завязка, главный конфликт, тон. Без серьёзных спойлеров — это hook.>

## Сюжет

> [!warning]- Спойлеры
>
> <Разбор по аркам/томам. Спойлеры допустимы. Каждая строка контента под `> `.>

## Персонажи

<Gallery-список персонажей — **НЕ таблица** (у манги нет сэйю, в отличие от anime-каста). Для каждого персонажа: карточка `CHARACTERS/<имя>.md` есть + `images.cover` → миниатюра 60 + WikiLink; карточка есть без cover → WikiLink без миниатюры; карточки нет → plain bold. WikiLinks на персонажей — ТОЛЬКО здесь (single-channel).>

- ![[<Char>_cover.<ext>|60]] **[[<Char>|<Имя>]]** — <одна строка: роль в произведении>.

## Автор и публикация

<Проза: автор(ы), **оригинальный издатель** (`publisher`), журнал (`serialized_in`), период серализации, контекст создания. Имена в прозе — plain text (издатель/журнал карточек пока не имеют). Затем gallery-список авторов (`PERSONS/`, ширина 60):>

- ![[<Author>_cover.<ext>|60]] **[[<Author>|<Имя>]]** — <роль: оригинальная история / художник / автор>.

## Связанные тайтлы

<Опционально, если есть `anime_adaptation`/`related_titles`. Аниме-экранизации (`ANIME/`) и связанные манги (`MANGA/`), gallery-формат, ширина 80:>

- ![[<Anime>_cover.<ext>|80]] **[[<Anime>|<Название>]]** (<год>) — аниме-экранизация.
- ![[<Manga>_cover.<ext>|80]] **[[<Manga>|<Название>]]** — <тип связи: сиквел/приквел/спинофф>.

## Резонанс

<Опционально, только для `status: finished` (либо classic с устоявшейся репутацией). Оценки/популярность (mal_score, rank, members — из прямого web fetch `<mal_url>`), награды (Tezuka, Kodansha, Shogakukan Manga Awards), культурное/жанровое влияние. Cutoff как у anime: онгоинг/нишевый без данных — секцию опустить. Плейсхолдеры «данных нет» не вставлять.>

## Личный отзыв

_Заполняется пользователем._
```

Размер заметки: 60–150 строк. Лучше короче и плотнее.

**Конвенция: WikiLinks на персонажей — только в `## Персонажи`.** В синопсисе/сюжете/прозе имена персонажей остаются plain text, даже если карточки существуют (single-channel).

**Секция `## Личный отзыв` — `USER-ONLY`:** только заголовок + `_Заполняется пользователем._`, без сгенерированного контента. Модель не выдумывает отзыв.

### 6. Проверить ссылки и собрать gallery-формат

Обязательные WikiLinks для `note_kind: manga` (если карточки существуют в волте):
- Каждый `authors[].person` → `PERSONS/` (gallery-секция `## Автор и публикация`).
- Каждый `anime_adaptation[]` → `ANIME/` (gallery-секция `## Связанные тайтлы`).
- Каждый `related_titles[]` → `MANGA/` (gallery-секция `## Связанные тайтлы`).
- Персонажи с карточками → `CHARACTERS/` (только `## Персонажи`).

**Gallery-формат** для всех — `Linking_guidelines.md` → «Gallery-стиль для backlink-списков»: для каждой цели прочитать frontmatter (Read), посмотреть `images.cover` → миниатюра + bold-WikiLink + описание (есть cover) / bold-WikiLink (нет cover) / plain bold (нет карточки). Ширина: **80** для тайтлов (anime/manga), **60** для персон/персонажей.

**Существование целей — детерминированно** (Glob/`vault-index MCP, tool vault_query`), не «по памяти». Карточка есть → запись обязана быть gallery-WikiLink, не plain-bold.

Проверки:
- Нет дубликатов ссылок (одна цель — один WikiLink на заметку).
- Все target существуют (Glob).
- Все embed'ы миниатюр резолвятся в реальные файлы в `attachments/`.

### 6.5. Обложка (vision-gate)

**Флаг `--no-images` / `-n`** (если в `$ARGUMENTS`) → весь шаг пропустить: `images`/embed опустить, пометить в отчёте; при разборе названия токен флага игнорировать. Probe/gate не нужны.

Иначе — работа с обложкой подчиняется секции `## Правила скачивания и валидации изображений` в `CLAUDE.md` (канон: vision-gate, curl/валидация, anti-clobber, расширение-по-типу, cover-cap). Кратко:

1. **Pre-flight probe ДО скачивания** — открыть через Read `.claude/assets/vision_probe.png`. Read дал визуал → модель мультимодальна, продолжать. Ошибка/метаданные → **СТОП** на обложке (ноль сетевых попыток): не классифицировать по имени/URL; карточку доделать текстом, в отчёт «обложка пропущена — модель не мультимодальна; добавить позже через `/add-images`».
2. **URL обложки** — приоритет: AniList `Media(type:MANGA).coverImage.extraLarge` > MAL manga `og:image` > обложка 1-го тома с фан-вики. **Расширение `<ext>` = реальный тип содержимого** (`Content-Type`/сигнатура), а НЕ хардкод `.png`: WebP→`.webp`, JPEG→`.jpg` (см. `Naming_conventions.md` → «Вложения»).
3. **Anti-clobber ДО записи** — целевой путь `attachments/<File_Name>_cover.<ext>`: если занят и это не наш cover этой же карточки → **СТОП** (коллизия, обычно симптом неуникального basename — вернуться к шагу 3), чужой файл не перезаписывать.
4. **Скачать** (`curl -L -f -o … -w '%{http_code}'`), **провалидировать ДО любого Read** (тип = реальное изображение JPEG/PNG/WebP по сигнатуре/`file`; размер ≥ 1 КБ; битый → удалить, следующий URL), затем **Read** для контент-верификации (та ли обложка/произведение).
5. **Прописать** `images.cover: "attachments/<File_Name>_cover.<ext>"` + вставить hero-embed под заголовком с потолком ширины `|300` (cover-cap волта, `Linking_guidelines.md`): `![[<File_Name>_cover.<ext>|300]]`.

Ни один источник не дал годной обложки → `images`/embed опустить, в отчёте сказать про отсутствие + путь через `/add-images`.

### 6.9. Проверка внутренней согласованности

Перед записью — прогнать по чеклисту (поймать само-противоречия):

- [ ] `status: finished` → `volumes`/`chapters` > 0 (у завершённой манги финальное число известно; `0` при finished — подозрительно). `status: publishing` → текущий счётчик или `0`, не финал.
- [ ] `demographic` не противоречит `serialized_in` (если журнал известен: Young Animal / Big Comic → seinen; Shounen Jump / Shounen Magazine → shounen; Margaret / Ribon → shoujo; и т.п.).
- [ ] Каждый тайтл в `anime_adaptation[]` — действительно экранизация ЭТОЙ манги (source-проверка по MAL/AniList Relations «Adaptation»), не просто тайтл того же автора / похожий.
- [ ] `authors[].role` (story/art/story-and-art) согласованы с прозой `## Автор и публикация`.
- [ ] `content_rating` согласован с жанрами (hentai→explicit, ecchi→nsfw); adult-теги — только при `nsfw`/`explicit`. `coloring` правдоподобен для `tradition` (webtoon/манхва обычно `full-color`).
- [ ] `USER-ONLY`-поля (`personal_status`, `personal_score`, `times_read`, `last_chapter_read`, `online_url`) и `## Личный отзыв` — НЕ выдуманы, оставлены пустыми.

Противоречие — не «дозаполнять» молча: исправить до согласованности либо оставить поле пустым и упомянуть в отчёте. Не подставлять произвольное значение ради заполненности.

### 7. Создать файл

Записать в `MANGA/<File_Name>.md`.

### 7.5. Обновить связанные карточки (реципрокность)

> **Reverse-leg правило (кросс-kind).** Записи, которые этот скилл пишет о манге в **чужие** карточки (`CHARACTERS/* ## Тайтлы`, `ANIME/* ## Связанные тайтлы`, `PERSONS/* ## Ключевые работы`) — reverse-leg-артефакты по `SYSTEM/Linking_guidelines.md` → «Reverse-leg: владение и cover-sync (кросс-kind)». Markup-миниатюра привязана к `images.cover` манги: при позднем добавлении обложки её синкают во **весь веер** входящих (`/add-images` + аудит манги); владение описанием — по тому, кто его написал (пути i/ii, git-blame).

Реципрокность manga↔character, manga↔anime и manga↔person(автор) — **ЖЕЛЕЗНАЯ** (ERROR, `reciprocity_pairs`). Forward-нога (создание манги) достраивает обратные рёбра:

**A. Персонажи (`## Персонажи` → `CHARACTERS/`).** Для каждого персонажа с карточкой `CHARACTERS/<имя>.md`:
1. Прочитать карточку.
2. `featured_in[]` — если этой манги нет, добавить (FK на `MANGA/` допустим, см. `Metadata_schema.md` → `featured_in`). Source-anchor: персонаж взят из source-верифицированного каста (MAL/AniList manga characters) — это подтверждение, отдельный fetch не нужен.
3. Секция `## Тайтлы` — если записи на эту мангу нет, добавить gallery-формат (ширина 80; миниатюра обложки манги, если скачана).
4. Идемпотентность (не дублировать) + обновить `updated`.

**B. Аниме-адаптации (`anime_adaptation[]` → `ANIME/`).** Для каждого тайтла с карточкой `ANIME/<title>.md`:
1. Прочитать карточку.
2. `manga_source[]` — если этой манги нет, добавить (FK на `MANGA/`).
3. Секция `## Связанные тайтлы` — если записи на эту мангу нет, добавить gallery-формат (ширина 80). Секции нет → отметить в отчёте, насильно не создавать.
4. Идемпотентность + `updated`.

**C. Связанные манги (`related_titles[]` → `MANGA/`).** Взаимность: если эта манга ссылается на B, B должна ссылаться обратно — добавить обратную ссылку во frontmatter + `## Связанные тайтлы` карточки B.

**D. Авторы (`authors[].person` → `PERSONS/`).** Зеркало `anime.staff[]↔person.works[]`. Для каждого автора с карточкой `PERSONS/<автор>.md`:
1. Прочитать карточку.
2. `works[]` — если записи `{title: <эта манга>, roles: [<mangaka|novelist>]}` нет, добавить (роль person — `mangaka` для манги / `novelist` для ранобэ; различие story/art остаётся на стороне манги в `authors[].role`).
3. Секция `## Ключевые работы` персоны — если записи на эту мангу нет, добавить gallery-формат (ширина 80; миниатюра обложки манги, если скачана), наравне с аниме-работами.
4. Идемпотентность (не дублировать title) + обновить `updated`.

**Backstop (само-проверка).** После A–D прогнать `vault-index MCP, tool vault_asymmetric_links` для пар manga↔character, manga↔anime и manga↔person по созданной карточке; любую оставшуюся одностороннюю связь достроить до нуля. **Forward-направление** (anime/character/person создаются ПОЗЖЕ манги) держит vault-wide backstop — `/fix-links asymmetric` + `/audit-note`; отдельных reverse-ног для манги в `/new-anime`//new-character`//new-person` нет (осознанный per-vault выбор).

### 8. Самоаудит

Прочитать `SYSTEM/Audit_checklist.md` и выполнить **все шаги** для **всех изменённых заметок** (созданная манга + обновлённые на шаге 7.5). Найденные ошибки — исправить, предупреждения — в отчёт.

### 9. Сообщить результат

Показать: имя файла, путь, основное название, число строк, ключевые WikiLinks, обновлённые связанные заметки (если были), результат аудита. Предложить `/verify` если устраивает.

## Важно

- `quality: draft` всегда — пользователь подтвердит через `/verify`.
- **НЕ ставить `co_authored` при создании.** Только через `/verify` или `/audit-note`.
- **`USER-ONLY`-поля и `## Личный отзыв`** (статус чтения, оценка, прогресс, отзыв) — оставить пустыми. Субъективные данные вписывает пользователь.
- Web research — обязательная часть фазы 2. Численные факты (`volumes`, `chapters`, `mal_score`, `year`) — из прямого web fetch конкретной страницы, не из snippet'ов.
- Единица учёта — **произведение**, не издание: `isbn`/`publisher`/число страниц тома намеренно отсутствуют.
- **Реципрокность manga↔character / manga↔anime / manga↔person(автор) — железная (шаг 7.5).** Forward-нога достраивает обратные рёбра при создании; backstop (`vault_asymmetric_links`) ловит пропуски итерации. Forward-направление от позже-созданных anime/character/person держит `/fix-links asymmetric`.
- Постер скачивать всегда, когда возможно — но через vision-gate (шаг 6.5). Не-мультимодальная модель пропускает обложку с пометкой, не оценивает по имени/URL.

<!-- BEGIN: spec-requirements (managed contract — sync with SYSTEM/spec_changelog.yaml) -->
```yaml
kind: manga
requirements:
  - requirement: reverse_leg_subject_artifact
    kind_of: format
  - requirement: tag_canon_discipline
    kind_of: format
  - requirement: title_cyrillic
    kind_of: field
```
<!-- END: spec-requirements -->
