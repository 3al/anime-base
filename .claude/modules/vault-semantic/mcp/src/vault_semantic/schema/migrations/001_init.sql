-- vault-semantic v0.1.0 baseline schema.
-- Spec: docs/RAG_Architecture.md §4.1 (tables), §4.2 (sync triggers), §4.6 (migration policy).
--
-- Применяется через миграционный механизм indexer'а (см. §4.6):
--   - Скрипт исполняется в одной транзакции.
--   - В конце INSERT INTO schema_version VALUES (1) фиксируется applied-version.
--
-- PRAGMA journal_mode=WAL, synchronous=NORMAL, foreign_keys=ON выставляются
-- indexer'ом при открытии connection, не в DDL (PRAGMA — connection-scoped).
-- foreign_keys=ON КРИТИЧЕН: без него ON DELETE CASCADE на chunks→notes молча
-- игнорируется, и осиротевшие строки остаются в chunks/chunks_vec/chunks_fts.
-- См. §4.7.
--
-- Embedding dimension hardcoded на 1024 (bge-m3). Смена embedding model
-- требует scope='full' reindex (новой схемы → новой миграции).

-- ----------------------------------------------------------------------------
-- schema_version: counter для §4.6 миграционного механизма.
-- ----------------------------------------------------------------------------
CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY
);

-- ----------------------------------------------------------------------------
-- notes: одна строка на .md-файл волта.
-- typed-колонки — known fields из SYSTEM/Metadata_schema.md (§4.4).
-- extra — JSON object с vault-специфичными полями.
-- ----------------------------------------------------------------------------
CREATE TABLE notes (
    id          INTEGER PRIMARY KEY,
    path        TEXT NOT NULL UNIQUE,
    mtime       INTEGER NOT NULL,
    hash        TEXT NOT NULL,
    indexed_at  INTEGER NOT NULL,

    type        TEXT,
    domain      TEXT,
    stability   TEXT,
    priority    TEXT,
    note_kind   TEXT,
    quality     TEXT,
    co_authored TEXT,
    created     TEXT,
    updated     TEXT,
    aliases     TEXT,

    extra       TEXT
);
CREATE INDEX idx_notes_type      ON notes(type);
CREATE INDEX idx_notes_domain    ON notes(domain);
CREATE INDEX idx_notes_note_kind ON notes(note_kind);
CREATE INDEX idx_notes_quality   ON notes(quality);
CREATE INDEX idx_notes_updated   ON notes(updated);

-- ----------------------------------------------------------------------------
-- tags: many-to-many. Junction table вместо JSON-колонки —
-- даёт нативный idx_tags_tag для быстрого фильтра по тегу.
-- ----------------------------------------------------------------------------
CREATE TABLE tags (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (note_id, tag)
);
CREATE INDEX idx_tags_tag ON tags(tag);

-- ----------------------------------------------------------------------------
-- chunks: единица retrieval. id выровнен с rowid в chunks_vec и chunks_fts.
-- text_lemmatized — отдельная колонка для FTS5 индексации (lemmatize-at-index,
-- см. §4.3).
-- ----------------------------------------------------------------------------
CREATE TABLE chunks (
    id                 INTEGER PRIMARY KEY,
    note_id            INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    ord                INTEGER NOT NULL,
    section_path       TEXT NOT NULL,
    line_start         INTEGER NOT NULL,
    line_end           INTEGER NOT NULL,
    text               TEXT NOT NULL,
    frontmatter_prefix TEXT NOT NULL,
    text_lemmatized    TEXT NOT NULL,
    hash               TEXT NOT NULL,
    UNIQUE (note_id, ord)
);
CREATE INDEX idx_chunks_note_id ON chunks(note_id);

-- ----------------------------------------------------------------------------
-- chunks_vec: dense embeddings (sqlite-vec).
-- vec0 не имеет FK; cleanup на удалении — через trigger ниже.
-- INSERT в vec0 делает indexer после embed() (триггеры не имеют доступа к ML).
-- ----------------------------------------------------------------------------
CREATE VIRTUAL TABLE chunks_vec USING vec0(
    embedding FLOAT[1024]
);

-- ----------------------------------------------------------------------------
-- chunks_fts: FTS5 lexical / BM25, external content.
-- Индексирует text_lemmatized → query lemmatize-at-query даёт совпадение.
-- ----------------------------------------------------------------------------
CREATE VIRTUAL TABLE chunks_fts USING fts5(
    text_lemmatized,
    content='chunks',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

-- ----------------------------------------------------------------------------
-- Sync triggers (§4.2). vec0/fts5 не имеют FK, поэтому мы вручную
-- зеркалим INSERT/UPDATE/DELETE из chunks.
-- ----------------------------------------------------------------------------
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text_lemmatized)
        VALUES('delete', OLD.id, OLD.text_lemmatized);
    DELETE FROM chunks_vec WHERE rowid = OLD.id;
END;

CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text_lemmatized)
        VALUES(NEW.id, NEW.text_lemmatized);
END;

CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text_lemmatized)
        VALUES('delete', OLD.id, OLD.text_lemmatized);
    INSERT INTO chunks_fts(rowid, text_lemmatized)
        VALUES(NEW.id, NEW.text_lemmatized);
END;

-- ----------------------------------------------------------------------------
-- Записываем applied-version. Migration runner сам не пишет — DDL должно
-- закрывать миграцию явным INSERT'ом, иначе recovery после crash будет
-- неоднозначен (см. §4.6).
-- ----------------------------------------------------------------------------
INSERT INTO schema_version (version) VALUES (1);
