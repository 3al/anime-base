"""Indexer — walk vault, parse frontmatter, chunk, embed, upsert SQLite.

Implements the contracts from RAG_Architecture.md:
  * §4.1–§4.2 — schema, lives in `schema/migrations/*.sql`.
  * §4.5      — incremental algorithm (mode='changed' / 'full').
  * §4.6      — migration runner (numbered .sql files, monotonic version).
  * §4.7      — connection pragmas (`journal_mode=WAL`,
                `synchronous=NORMAL`, `foreign_keys=ON` — last is critical;
                without it CASCADE silently no-ops).
  * §3.1      — per-note pipeline ties together chunking + lemmatizer +
                embedding.

Public surface:
  * `connect(db_path)` — open a configured connection (pragmas, vec ext,
    pending migrations applied).
  * `reindex(vault_root, db_path, ...)` — main entry from MCP tools.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator

from .chunking import (
    Chunk,
    ChunkerConfig,
    NoteMeta,
    chunk_note,
    compose_note_prefix,
)
from .embedding import EmbeddingConfig, encode, get_embedding_dim
from .lemmatizer import lemmatize


# ---------------------------------------------------------------------------
# Constants & types
# ---------------------------------------------------------------------------

# Hardcoded set of typed columns in `notes` per §4.4 v0.1.0. `aliases` is
# stored as JSON text. `extra` holds everything not in this set.
_TYPED_FIELDS = (
    "type",
    "domain",
    "stability",
    "priority",
    "note_kind",
    "quality",
    "co_authored",
    "created",
    "updated",
)

_MIGRATIONS_DIR = Path(__file__).parent / "schema" / "migrations"


@dataclass
class ReindexStats:
    scanned: int = 0
    new: int = 0
    changed: int = 0
    unchanged: int = 0
    touched: int = 0  # mtime bumped, content unchanged → no re-embed
    deleted: int = 0
    chunks_written: int = 0
    elapsed_ms: int = 0
    errors: list[dict[str, str]] = field(default_factory=list)
    mode: str = "changed"
    dry_run: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "scanned": self.scanned,
            "new": self.new,
            "changed": self.changed,
            "unchanged": self.unchanged,
            "touched": self.touched,
            "deleted": self.deleted,
            "chunks_written": self.chunks_written,
            "elapsed_ms": self.elapsed_ms,
            "errors": list(self.errors),
            "mode": self.mode,
            "dry_run": self.dry_run,
        }


# ---------------------------------------------------------------------------
# Connection setup
# ---------------------------------------------------------------------------


def connect(db_path: str | Path) -> sqlite3.Connection:
    """Open SQLite + load sqlite-vec + apply pragmas + run pending migrations."""
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    # vec0 extension MUST be loaded before any DDL touching chunks_vec.
    _load_vec_extension(conn)

    # §4.7 — pragmas. `foreign_keys` is connection-scoped and critical.
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")

    _apply_migrations(conn)
    return conn


def _load_vec_extension(conn: sqlite3.Connection) -> None:
    import sqlite_vec  # type: ignore[import-not-found]

    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)


def _apply_migrations(conn: sqlite3.Connection) -> None:
    """Run NNN_*.sql in order; refuse downgrade (db newer than disk).

    On fresh DB `schema_version` doesn't exist; we treat that as version 0
    rather than bootstrapping the table — `001_init.sql` creates it itself
    (without `IF NOT EXISTS`), so a pre-bootstrap would collide.
    """
    has_schema_version = (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'"
        ).fetchone()
        is not None
    )
    if has_schema_version:
        row = conn.execute("SELECT MAX(version) AS v FROM schema_version").fetchone()
        current = (row["v"] if row and row["v"] is not None else 0)
    else:
        current = 0

    migrations: list[tuple[int, Path]] = []
    if _MIGRATIONS_DIR.exists():
        for p in sorted(_MIGRATIONS_DIR.glob("*.sql")):
            num_str = p.name.split("_", 1)[0]
            if not num_str.isdigit():
                continue
            migrations.append((int(num_str), p))

    available_max = max((n for n, _ in migrations), default=0)
    if current > available_max:
        raise RuntimeError(
            f"DB schema version {current} > max migration on disk {available_max}. "
            "Refusing to downgrade. Either upgrade the module or recreate DB."
        )

    for num, path in migrations:
        if num <= current:
            continue
        sql = path.read_text(encoding="utf-8")
        with conn:
            conn.executescript(sql)
            # 001_init.sql already inserts (1) itself; do not double-insert.
            row = conn.execute(
                "SELECT 1 FROM schema_version WHERE version = ?", (num,)
            ).fetchone()
            if row is None:
                conn.execute("INSERT INTO schema_version (version) VALUES (?)", (num,))


# ---------------------------------------------------------------------------
# Frontmatter parsing
# ---------------------------------------------------------------------------


def _parse_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    """Split `---\\n<yaml>\\n---\\n<body>` into (meta, body).

    Tolerant: malformed YAML or missing front delimiter → ({}, content).
    """
    # Detect leading `---` (allow trailing whitespace, allow LF or CRLF).
    if not content.startswith("---"):
        return {}, content
    # Match first line entirely; YAML opener must be `---` followed by EOL.
    nl = content.find("\n", 0, 8)
    if nl == -1 or content[3:nl].strip() != "":
        return {}, content

    rest = content[nl + 1 :]
    # Find closing `---` line.
    idx = 0
    end = -1
    after = -1
    while idx < len(rest):
        line_end = rest.find("\n", idx)
        if line_end == -1:
            line = rest[idx:]
            line_break = len(rest)
        else:
            line = rest[idx:line_end]
            line_break = line_end + 1
        if line.strip() == "---":
            end = idx
            after = line_break
            break
        idx = line_break
    if end == -1 or after == -1:
        return {}, content

    yaml_block = rest[:end]
    body = rest[after:]

    try:
        import yaml  # type: ignore[import-not-found]

        meta = yaml.safe_load(yaml_block)
    except Exception:
        return {}, content
    if not isinstance(meta, dict):
        return {}, content
    return meta, body


def _normalize_meta(meta: dict[str, Any]) -> dict[str, Any]:
    """Extract typed columns + tags + aliases + extra from raw frontmatter dict.

    Returns a dict shaped for `_upsert_note`: {<typed_field>: str|None,
    'tags': list[str], 'aliases': list[str], 'extra': dict}.
    Permissive coercion (§7): scalars → str, lists kept, missing → None.
    """
    out: dict[str, Any] = {f: None for f in _TYPED_FIELDS}
    out["tags"] = []
    out["aliases"] = []
    extra: dict[str, Any] = {}

    for key, val in meta.items():
        if key in _TYPED_FIELDS:
            out[key] = None if val is None else str(val)
        elif key == "tags":
            out["tags"] = _coerce_string_list(val)
        elif key == "aliases":
            out["aliases"] = _coerce_string_list(val)
        else:
            extra[key] = val

    out["extra"] = extra
    return out


def _coerce_string_list(val: Any) -> list[str]:
    if val is None:
        return []
    if isinstance(val, list):
        return [str(x) for x in val if x is not None]
    if isinstance(val, str):
        return [val] if val else []
    return [str(val)]


# ---------------------------------------------------------------------------
# File walking & hashing
# ---------------------------------------------------------------------------


def _walk_vault(vault_root: Path) -> Iterator[tuple[str, Path, int]]:
    """Yield (rel_posix_path, abs_path, fs_mtime_int) for every .md file."""
    for root, dirs, files in os.walk(vault_root):
        # Skip dotted dirs (.obsidian, .git, .claude).
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for fname in files:
            if not fname.endswith(".md"):
                continue
            abs_path = Path(root) / fname
            rel_path = abs_path.relative_to(vault_root).as_posix()
            try:
                mtime = int(abs_path.stat().st_mtime)
            except OSError:
                continue
            yield rel_path, abs_path, mtime


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(64 * 1024), b""):
            h.update(block)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Note upsert + chunk replacement
# ---------------------------------------------------------------------------


def _upsert_note(
    conn: sqlite3.Connection,
    *,
    rel_path: str,
    mtime: int,
    file_hash: str,
    indexed_at: int,
    norm: dict[str, Any],
) -> int:
    """INSERT or UPDATE notes row; return note_id."""
    typed_vals = tuple(norm[f] for f in _TYPED_FIELDS)
    aliases_json = (
        json.dumps(norm["aliases"], ensure_ascii=False) if norm["aliases"] else None
    )
    extra_json = (
        json.dumps(norm["extra"], ensure_ascii=False) if norm["extra"] else None
    )

    typed_cols = ", ".join(_TYPED_FIELDS)
    typed_placeholders = ", ".join(["?"] * len(_TYPED_FIELDS))
    typed_assign = ", ".join(f"{f} = excluded.{f}" for f in _TYPED_FIELDS)

    conn.execute(
        f"""
        INSERT INTO notes
            (path, mtime, hash, indexed_at, {typed_cols}, aliases, extra)
        VALUES
            (?,    ?,     ?,    ?,          {typed_placeholders}, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            mtime = excluded.mtime,
            hash = excluded.hash,
            indexed_at = excluded.indexed_at,
            {typed_assign},
            aliases = excluded.aliases,
            extra = excluded.extra
        """,
        (rel_path, mtime, file_hash, indexed_at, *typed_vals, aliases_json, extra_json),
    )
    row = conn.execute("SELECT id FROM notes WHERE path = ?", (rel_path,)).fetchone()
    return int(row["id"])


def _replace_tags(conn: sqlite3.Connection, note_id: int, tags: list[str]) -> None:
    conn.execute("DELETE FROM tags WHERE note_id = ?", (note_id,))
    if tags:
        conn.executemany(
            "INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)",
            [(note_id, t) for t in tags if t],
        )


def _delete_chunks(conn: sqlite3.Connection, note_id: int) -> None:
    """Delete chunks; trigger `chunks_ad` cleans chunks_fts and chunks_vec."""
    conn.execute("DELETE FROM chunks WHERE note_id = ?", (note_id,))


def _insert_chunks(
    conn: sqlite3.Connection,
    *,
    note_id: int,
    chunks: list[Chunk],
    embeddings: Any,
) -> None:
    """Insert chunks (FTS5 syncs via trigger), then vec0 rows by rowid."""
    chunk_ids: list[int] = []
    for c in chunks:
        text_for_fts = lemmatize(c.frontmatter_prefix + "\n---\n" + c.text)
        cur = conn.execute(
            """
            INSERT INTO chunks
                (note_id, ord, section_path, line_start, line_end,
                 text, frontmatter_prefix, text_lemmatized, hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                note_id,
                c.ord,
                c.section_path_json,
                c.line_start,
                c.line_end,
                c.text,
                c.frontmatter_prefix,
                text_for_fts,
                c.hash,
            ),
        )
        chunk_ids.append(int(cur.lastrowid or 0))

    if not chunk_ids:
        return

    # vec0 INSERT: convert embedding row → bytes (sqlite-vec accepts numpy
    # float32 arrays directly via its serialize helper, but plain bytes are
    # the lowest-common-denominator path).
    import sqlite_vec  # type: ignore[import-not-found]

    for cid, emb in zip(chunk_ids, embeddings):
        # sqlite-vec serialize_float32 handles list[float] | np.ndarray.
        blob = sqlite_vec.serialize_float32(list(emb))
        conn.execute(
            "INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)",
            (cid, blob),
        )


def _delete_note_by_path(conn: sqlite3.Connection, rel_path: str) -> int:
    """Delete one note (cascades to chunks/vec/fts via FK + triggers).

    Returns 1 if deleted, 0 if not found.
    """
    cur = conn.execute("DELETE FROM notes WHERE path = ?", (rel_path,))
    return cur.rowcount or 0


# ---------------------------------------------------------------------------
# Per-note re-index orchestration
# ---------------------------------------------------------------------------


def _index_note(
    conn: sqlite3.Connection,
    *,
    rel_path: str,
    abs_path: Path,
    mtime: int,
    file_hash: str,
    chunker_config: ChunkerConfig,
    embedding_config: EmbeddingConfig,
) -> int:
    """Re-index a single note end-to-end. Returns chunks_written count."""
    raw = abs_path.read_text(encoding="utf-8")
    meta_raw, body = _parse_frontmatter(raw)
    norm = _normalize_meta(meta_raw)

    indexed_at = int(time.time())
    note_id = _upsert_note(
        conn,
        rel_path=rel_path,
        mtime=mtime,
        file_hash=file_hash,
        indexed_at=indexed_at,
        norm=norm,
    )
    _replace_tags(conn, note_id, norm["tags"])
    _delete_chunks(conn, note_id)

    # §3.4 — exclude top-level H1 if it matches note title. Obsidian
    # convention: filename uses underscores ("Lepiota_Magnispora.md"),
    # markdown H1 uses spaces ("# Lepiota Magnispora"). Normalize both
    # sides for the comparison so the H1 isn't double-recorded in
    # section_path.
    title = abs_path.stem.replace("_", " ")
    note_meta_obj = NoteMeta(
        path=rel_path,
        type=norm["type"],
        domain=norm["domain"],
        note_kind=norm["note_kind"],
        quality=norm["quality"],
        stability=norm["stability"],
        priority=norm["priority"],
        co_authored=norm["co_authored"],
        tags=norm["tags"],
        aliases=norm["aliases"],
    )
    note_prefix = compose_note_prefix(note_meta_obj)
    chunks = chunk_note(
        body,
        note_prefix=note_prefix,
        title=title,
        config=chunker_config,
    )
    if not chunks:
        return 0

    encoder_inputs = [c.frontmatter_prefix + "\n---\n" + c.text for c in chunks]
    embeddings = encode(encoder_inputs, query=False, config=embedding_config)
    _insert_chunks(conn, note_id=note_id, chunks=chunks, embeddings=embeddings)
    return len(chunks)


# ---------------------------------------------------------------------------
# Public reindex
# ---------------------------------------------------------------------------


@dataclass
class _ProgressEvent:
    kind: str  # 'note_done' | 'note_skipped' | 'note_error' | 'deleted' | 'finalize'
    rel_path: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)


ProgressCallback = Callable[[_ProgressEvent], None]


def reindex(
    vault_root: str | Path,
    db_path: str | Path,
    *,
    scope: str = "changed",
    dry_run: bool = False,
    chunker_config: ChunkerConfig | None = None,
    embedding_config: EmbeddingConfig | None = None,
    progress_cb: ProgressCallback | None = None,
) -> ReindexStats:
    """Walk vault → upsert per §4.5 incremental algorithm.

    `scope='full'` deletes all `notes` rows first (FK cascade clears chunks
    and triggers clear vec/fts), then runs the same per-note pipeline. The
    schema itself is NOT recreated — to swap embedding dim use a migration.
    `dry_run=True` walks + classifies but does not write or load embeddings.
    """
    if scope not in ("changed", "full"):
        raise ValueError(f"scope must be 'changed' or 'full', got {scope!r}")

    vault_root = Path(vault_root).resolve()
    if not vault_root.exists():
        raise FileNotFoundError(f"vault_root does not exist: {vault_root}")

    cfg_chunker = chunker_config or ChunkerConfig()
    cfg_embed = embedding_config or EmbeddingConfig()

    started = time.perf_counter()
    stats = ReindexStats(mode=scope, dry_run=dry_run)

    conn = connect(db_path)
    try:
        if not dry_run:
            _verify_embedding_dim(conn, cfg_embed)

        if scope == "full" and not dry_run:
            with conn:
                conn.execute("DELETE FROM notes")  # cascades + triggers fire

        in_db: dict[str, dict[str, Any]] = {
            row["path"]: {"mtime": row["mtime"], "hash": row["hash"]}
            for row in conn.execute("SELECT path, mtime, hash FROM notes")
        }

        on_disk_paths: set[str] = set()

        for rel_path, abs_path, fs_mtime in _walk_vault(vault_root):
            stats.scanned += 1
            on_disk_paths.add(rel_path)

            existing = in_db.get(rel_path)
            classification = _classify(existing, fs_mtime, abs_path, scope)

            if classification == "skip":
                stats.unchanged += 1
                continue
            if classification == "touch":
                stats.touched += 1
                if not dry_run:
                    with conn:
                        conn.execute(
                            "UPDATE notes SET mtime = ?, indexed_at = ? WHERE path = ?",
                            (fs_mtime, int(time.time()), rel_path),
                        )
                continue

            # 'new' or 'changed' — re-index.
            if classification == "new":
                stats.new += 1
            else:
                stats.changed += 1

            if dry_run:
                continue

            try:
                file_hash = _file_sha256(abs_path)
                with conn:
                    written = _index_note(
                        conn,
                        rel_path=rel_path,
                        abs_path=abs_path,
                        mtime=fs_mtime,
                        file_hash=file_hash,
                        chunker_config=cfg_chunker,
                        embedding_config=cfg_embed,
                    )
                stats.chunks_written += written
                if progress_cb:
                    progress_cb(_ProgressEvent("note_done", rel_path, {"chunks": written}))
            except Exception as exc:  # noqa: BLE001
                stats.errors.append({"path": rel_path, "error": str(exc)})
                if progress_cb:
                    progress_cb(_ProgressEvent("note_error", rel_path, {"error": str(exc)}))

        # Deletions: in_db minus on_disk.
        for rel_path in in_db.keys() - on_disk_paths:
            if dry_run:
                stats.deleted += 1
                continue
            with conn:
                if _delete_note_by_path(conn, rel_path):
                    stats.deleted += 1
                    if progress_cb:
                        progress_cb(_ProgressEvent("deleted", rel_path))

    finally:
        conn.close()

    stats.elapsed_ms = int((time.perf_counter() - started) * 1000)
    return stats


def _classify(
    existing: dict[str, Any] | None, fs_mtime: int, abs_path: Path, scope: str
) -> str:
    """One file → one of {new, changed, touch, skip}.

    'skip' = mtime unchanged (cheap path). 'touch' = mtime bumped but content
    hash matches DB (frontmatter / save reformat / git checkout). 'changed'
    = content actually different. 'new' = path not in DB.
    """
    if scope == "full":
        # DELETE FROM notes already happened; everything is 'new'.
        return "new"
    if existing is None:
        return "new"
    if fs_mtime == existing["mtime"]:
        return "skip"
    # mtime moved — compare content hash to disambiguate touch vs change.
    new_hash = _file_sha256(abs_path)
    if new_hash == existing["hash"]:
        return "touch"
    return "changed"


def _verify_embedding_dim(conn: sqlite3.Connection, cfg: EmbeddingConfig) -> None:
    """Best-effort guard from §2.6: configured model dim must match stored vec0 dim.

    sqlite-vec's vec0 fixes the dimension at CREATE TABLE time; mismatch
    blows up on first INSERT with an opaque error. We pre-flight by comparing
    schema-introspection vs `get_embedding_dim()`.
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE name = 'chunks_vec'"
    ).fetchone()
    if not row or not row["sql"]:
        return  # table not created yet — first connect will via migration

    sql = row["sql"]
    # Parse FLOAT[N] from the DDL. Crude but the DDL is ours.
    import re

    m = re.search(r"FLOAT\s*\[\s*(\d+)\s*\]", sql, re.IGNORECASE)
    if not m:
        return
    schema_dim = int(m.group(1))

    try:
        cfg_dim = get_embedding_dim(cfg)
    except Exception:
        # If model can't load (offline + uncached), skip pre-flight — the
        # actual encode call will surface a clean EmbeddingUnavailable.
        return

    if cfg_dim != schema_dim:
        raise RuntimeError(
            f"Embedding dim mismatch: chunks_vec schema = FLOAT[{schema_dim}], "
            f"configured model '{cfg.model}' produces dim {cfg_dim}. "
            "Run vault_semantic_reindex(scope='full') after a migration "
            "that recreates chunks_vec with the new dim."
        )


# ---------------------------------------------------------------------------
# Lazy refresh-on-query (Phase 4.6, see Roadmap)
# ---------------------------------------------------------------------------
#
# Mirrors vault-index `ensureFresh()`/`refresh()` (modules/vault-index/mcp/src/
# vault-index.ts:46-53, 208-248). The semantic index is the DB on disk, but
# the in-memory mtime snapshot lets us short-circuit a no-op scope='changed'
# scan when nothing on disk has moved since the previous check.
#
# Guarantees:
#   * Debounce — sub-`DEFAULT_REFRESH_DEBOUNCE_S` repeat calls are no-ops.
#   * Skip-if-no-mtime-change — if every file's mtime matches the snapshot
#     from the previous refresh, do NOT touch SQLite at all.
#   * First call per process — snapshot is None → fall through to a real
#     reindex(scope='changed'), which itself fast-paths unchanged notes
#     via `_classify` (DB-mtime compare, no re-embed).

DEFAULT_REFRESH_DEBOUNCE_S = 2.0


@dataclass
class _RefreshState:
    last_refresh_monotonic: float = 0.0
    mtime_snapshot: dict[str, int] | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)


_REFRESH = _RefreshState()


def _bootstrap_snapshot_from_db(db_path: Path) -> dict[str, int] | None:
    """First-call bootstrap: read `{path: mtime}` from an existing DB so
    that an in-sync vault skips reindex (and therefore skips model load).

    Returns None if the DB doesn't exist, is empty, or can't be read — in
    those cases we want the caller to fall through to a real reindex.
    Uses a raw sqlite3 connection (no migrations, no vec extension) — we
    only SELECT two columns from `notes`.
    """
    if not db_path.exists():
        return None
    try:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute("SELECT path, mtime FROM notes").fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return None
    if not rows:
        return None
    return {row["path"]: int(row["mtime"]) for row in rows}


def incremental_refresh(
    vault_root: str | Path,
    db_path: str | Path,
    *,
    debounce_seconds: float = DEFAULT_REFRESH_DEBOUNCE_S,
    chunker_config: ChunkerConfig | None = None,
    embedding_config: EmbeddingConfig | None = None,
) -> dict[str, Any]:
    """Cheap freshen-before-query. Returns a status dict for telemetry/tests.

    status ∈ {"debounced", "unchanged", "refreshed"}.

    Safe to call from every search/stats invocation — typical cost on the
    unchanged path is one stat-syscall per .md file plus one DB SELECT on
    the very first call (~50-100 ms for 75 notes on a warm cache).
    """
    started = time.monotonic()
    with _REFRESH.lock:
        elapsed = started - _REFRESH.last_refresh_monotonic
        if elapsed < debounce_seconds and _REFRESH.last_refresh_monotonic > 0:
            return {
                "status": "debounced",
                "since_last_ms": int(elapsed * 1000),
            }

        vault_root_p = Path(vault_root).resolve()
        db_path_p = Path(db_path)
        new_snapshot: dict[str, int] = {}
        for rel_path, _, mt in _walk_vault(vault_root_p):
            new_snapshot[rel_path] = mt

        prior = _REFRESH.mtime_snapshot
        if prior is None:
            # First call this process — bootstrap from DB to avoid forcing
            # a model-loading reindex when the DB is already in sync.
            prior = _bootstrap_snapshot_from_db(db_path_p)

        if prior is not None and prior == new_snapshot:
            _REFRESH.mtime_snapshot = new_snapshot
            _REFRESH.last_refresh_monotonic = time.monotonic()
            return {
                "status": "unchanged",
                "notes_scanned": len(new_snapshot),
            }

        stats = reindex(
            vault_root=vault_root_p,
            db_path=db_path_p,
            scope="changed",
            chunker_config=chunker_config,
            embedding_config=embedding_config,
        )
        _REFRESH.mtime_snapshot = new_snapshot
        # Stamp at *end* of work, not at start — otherwise a long reindex
        # (model-load on cold start, batch reindex on many changes) blows
        # past the debounce window before the next request arrives.
        _REFRESH.last_refresh_monotonic = time.monotonic()
        return {"status": "refreshed", "stats": stats.to_dict()}


def ensure_fresh_safe(
    vault_root: str | Path,
    db_path: str | Path,
) -> dict[str, Any] | None:
    """Call `incremental_refresh` and swallow errors — never let a flaky
    refresh break a search/stats call. Returns the refresh result on success,
    None on failure (with a warning on stderr)."""
    try:
        return incremental_refresh(vault_root, db_path)
    except Exception as exc:  # noqa: BLE001
        print(
            f"WARN vault-semantic: incremental_refresh failed: {exc}",
            file=sys.stderr,
        )
        return None
