"""Hybrid retrieval — dense (vec0) + BM25 (FTS5) + RRF.

Implements RAG_Architecture.md §5 (search API), §5.2 (RRF), §5.3 (score
normalization), §5.4 (mode selection + auto-fallback), §6 (filter spec).

Public API:
  * `search(...)` — returns `SearchResponse`.
  * `INDEX_NOT_INITIALIZED` / `EMPTY_QUERY` / `EMBEDDING_MODEL_UNAVAILABLE` —
    error sentinels raised as `SearchError`. Server.py maps them to MCP
    error responses (§5.7).

Filter SQL builder (`_filter_to_sql`) is exported for unit tests; everything
else is internal.
"""

from __future__ import annotations

import math
import sqlite3
import time
from typing import Any

from .embedding import EmbeddingConfig, EmbeddingUnavailable, encode
from .indexer import connect
from .lemmatizer import lemmatize
from .models import ChunkResult, FilterSpec, FilterWarning, SearchResponse


# ---------------------------------------------------------------------------
# Constants from §5.2 / §5.3
# ---------------------------------------------------------------------------

K_RRF = 60
K_HARD_CAP = 100  # absolute schema ceiling (config k_ceiling may not exceed it)
K_CEILING = 40    # v0.5.0 active default clamp on per-call k (anti-runaway)
DEFAULT_K = 12    # v0.5.0: lowered 20→12 — leaner default keeps payload in-context
BM25_SCALE = 10.0  # exp(-bm25_raw / scale) — see §5.3

# Pre-retrieval filter knowledge — must stay in sync with §6.2.
_TYPED_TEXT_FIELDS = (
    "type",
    "domain",
    "stability",
    "priority",
    "note_kind",
    "quality",
    "co_authored",
)
_DATE_FIELDS = ("created", "updated")


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class SearchError(RuntimeError):
    """Carries a `code` matching §5.7 for server.py to surface as MCP error."""

    def __init__(self, code: str, message: str, data: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.data = data or {}


# ---------------------------------------------------------------------------
# FilterSpec → SQL WHERE
# ---------------------------------------------------------------------------


def _filter_to_sql(
    spec: FilterSpec | None,
) -> tuple[str, list[Any], list[FilterWarning], bool]:
    """Compile FilterSpec into (where_sql, params, warnings, needs_tags_join).

    `where_sql` is a fragment WITHOUT the `WHERE` keyword; caller injects.
    `needs_tags_join` is True when any tag-predicate is present (forces
    a JOIN tags scope).
    """
    warnings: list[FilterWarning] = []
    if not spec:
        return "1=1", [], warnings, False

    parts, params, needs_tags = _compile_object(spec, warnings, depth=0)
    if not parts:
        return "1=1", params, warnings, needs_tags
    return " AND ".join(parts), params, warnings, needs_tags


def _compile_object(
    spec: dict[str, Any],
    warnings: list[FilterWarning],
    depth: int,
) -> tuple[list[str], list[Any], bool]:
    if depth > 3:
        warnings.append(
            FilterWarning(field="$or", reason="depth_exceeded", detail="max=3")
        )
        return [], [], False

    parts: list[str] = []
    params: list[Any] = []
    needs_tags = False

    for field, predicate in spec.items():
        if field == "$or":
            sub_clauses: list[str] = []
            for sub in predicate or []:
                if not isinstance(sub, dict):
                    continue
                sub_parts, sub_params, sub_tags = _compile_object(
                    sub, warnings, depth + 1
                )
                if sub_parts:
                    sub_clauses.append("(" + " AND ".join(sub_parts) + ")")
                    params.extend(sub_params)
                    needs_tags = needs_tags or sub_tags
            if sub_clauses:
                parts.append("(" + " OR ".join(sub_clauses) + ")")
            continue

        if field.startswith("extra."):
            sql, p = _compile_extra(field, predicate, warnings)
            if sql:
                parts.append(sql)
                params.extend(p)
            continue

        if field == "tags":
            sql, p = _compile_tags(predicate, warnings)
            if sql:
                parts.append(sql)
                params.extend(p)
                needs_tags = True
            continue

        if field == "aliases":
            sql, p = _compile_aliases(predicate, warnings)
            if sql:
                parts.append(sql)
                params.extend(p)
            continue

        if field == "path":
            sql, p = _compile_path(predicate, warnings)
            if sql:
                parts.append(sql)
                params.extend(p)
            continue

        if field in _DATE_FIELDS:
            sql, p = _compile_date(field, predicate, warnings)
            if sql:
                parts.append(sql)
                params.extend(p)
            continue

        if field in _TYPED_TEXT_FIELDS:
            sql, p = _compile_scalar(field, predicate, warnings)
            if sql:
                parts.append(sql)
                params.extend(p)
            continue

        warnings.append(FilterWarning(field=field, reason="unknown_field"))

    return parts, params, needs_tags


def _compile_scalar(
    field: str, predicate: Any, warnings: list[FilterWarning]
) -> tuple[str, list[Any]]:
    col = f"n.{field}"
    if predicate is None:
        return f"{col} IS NULL", []
    if isinstance(predicate, (str, int, float, bool)):
        return f"{col} = ?", [predicate]
    if isinstance(predicate, list):
        if not predicate:
            return "0=1", []  # empty IN — never matches
        ph = ",".join(["?"] * len(predicate))
        return f"{col} IN ({ph})", list(predicate)
    if isinstance(predicate, dict):
        if "any" in predicate:
            vals = predicate["any"] or []
            if not vals:
                return "0=1", []
            ph = ",".join(["?"] * len(vals))
            return f"{col} IN ({ph})", list(vals)
        if "none" in predicate:
            vals = predicate["none"] or []
            if not vals:
                return "1=1", []
            ph = ",".join(["?"] * len(vals))
            return f"({col} NOT IN ({ph}) OR {col} IS NULL)", list(vals)
        if "not" in predicate:
            inner_sql, inner_params = _compile_scalar(field, predicate["not"], warnings)
            if inner_sql:
                return f"NOT ({inner_sql})", inner_params
            return "", []
        if "is_null" in predicate:
            return f"{col} IS NULL" if predicate["is_null"] else f"{col} IS NOT NULL", []
        if "all" in predicate:
            warnings.append(
                FilterWarning(
                    field=field,
                    reason="unsupported_predicate",
                    detail="'all' on scalar field",
                )
            )
            return "", []
        if any(k in predicate for k in ("after", "before", "between")):
            warnings.append(
                FilterWarning(
                    field=field,
                    reason="unsupported_predicate",
                    detail="date-range on non-date field",
                )
            )
            return "", []
    warnings.append(FilterWarning(field=field, reason="invalid_predicate"))
    return "", []


def _compile_date(
    field: str, predicate: Any, warnings: list[FilterWarning]
) -> tuple[str, list[Any]]:
    col = f"n.{field}"
    if predicate is None:
        return f"{col} IS NULL", []
    if isinstance(predicate, str):
        return f"{col} = ?", [predicate]
    if isinstance(predicate, dict):
        if "after" in predicate:
            return f"{col} > ?", [predicate["after"]]
        if "before" in predicate:
            return f"{col} < ?", [predicate["before"]]
        if "between" in predicate:
            rng = predicate["between"] or []
            if len(rng) != 2:
                warnings.append(
                    FilterWarning(
                        field=field,
                        reason="invalid_value",
                        detail="between expects [start, end]",
                    )
                )
                return "", []
            return f"{col} BETWEEN ? AND ?", [rng[0], rng[1]]
        if "is_null" in predicate:
            return f"{col} IS NULL" if predicate["is_null"] else f"{col} IS NOT NULL", []
    warnings.append(FilterWarning(field=field, reason="invalid_predicate"))
    return "", []


def _compile_tags(
    predicate: Any, warnings: list[FilterWarning]
) -> tuple[str, list[Any]]:
    """`tags` JOINs `tags` table; predicate dictates HAVING clause shape."""
    if isinstance(predicate, list) or (isinstance(predicate, dict) and "any" in predicate):
        vals = predicate if isinstance(predicate, list) else (predicate["any"] or [])
        if not vals:
            return "0=1", []
        ph = ",".join(["?"] * len(vals))
        return (
            f"n.id IN (SELECT note_id FROM tags WHERE tag IN ({ph}))",
            list(vals),
        )
    if isinstance(predicate, dict):
        if "all" in predicate:
            vals = predicate["all"] or []
            if not vals:
                return "1=1", []
            ph = ",".join(["?"] * len(vals))
            return (
                f"n.id IN (SELECT note_id FROM tags WHERE tag IN ({ph}) "
                f"GROUP BY note_id HAVING COUNT(DISTINCT tag) = ?)",
                list(vals) + [len(vals)],
            )
        if "none" in predicate:
            vals = predicate["none"] or []
            if not vals:
                return "1=1", []
            ph = ",".join(["?"] * len(vals))
            return (
                f"n.id NOT IN (SELECT note_id FROM tags WHERE tag IN ({ph}))",
                list(vals),
            )
        if "is_null" in predicate:
            if predicate["is_null"]:
                return "n.id NOT IN (SELECT note_id FROM tags)", []
            return "n.id IN (SELECT note_id FROM tags)", []
    warnings.append(FilterWarning(field="tags", reason="invalid_predicate"))
    return "", []


def _compile_aliases(
    predicate: Any, warnings: list[FilterWarning]
) -> tuple[str, list[Any]]:
    """`aliases` is JSON array text in notes.aliases; query via json_each."""
    if isinstance(predicate, str):
        return (
            "EXISTS (SELECT 1 FROM json_each(n.aliases) WHERE value = ?)",
            [predicate],
        )
    if isinstance(predicate, list) or (isinstance(predicate, dict) and "any" in predicate):
        vals = predicate if isinstance(predicate, list) else (predicate["any"] or [])
        if not vals:
            return "0=1", []
        ph = ",".join(["?"] * len(vals))
        return (
            f"EXISTS (SELECT 1 FROM json_each(n.aliases) WHERE value IN ({ph}))",
            list(vals),
        )
    if isinstance(predicate, dict):
        if "all" in predicate:
            vals = predicate["all"] or []
            if not vals:
                return "1=1", []
            clauses = " AND ".join(
                ["EXISTS (SELECT 1 FROM json_each(n.aliases) WHERE value = ?)"] * len(vals)
            )
            return clauses, list(vals)
        if "none" in predicate:
            vals = predicate["none"] or []
            if not vals:
                return "1=1", []
            ph = ",".join(["?"] * len(vals))
            return (
                f"NOT EXISTS (SELECT 1 FROM json_each(n.aliases) WHERE value IN ({ph}))",
                list(vals),
            )
        if "is_null" in predicate:
            if predicate["is_null"]:
                return "n.aliases IS NULL", []
            return "n.aliases IS NOT NULL", []
    warnings.append(FilterWarning(field="aliases", reason="invalid_predicate"))
    return "", []


def _compile_path(
    predicate: Any, warnings: list[FilterWarning]
) -> tuple[str, list[Any]]:
    if isinstance(predicate, str):
        return "n.path = ?", [predicate]
    if isinstance(predicate, list):
        if not predicate:
            return "0=1", []
        ph = ",".join(["?"] * len(predicate))
        return f"n.path IN ({ph})", list(predicate)
    if isinstance(predicate, dict):
        if "any" in predicate:
            vals = predicate["any"] or []
            if not vals:
                return "0=1", []
            ph = ",".join(["?"] * len(vals))
            return f"n.path IN ({ph})", list(vals)
        if "prefix" in predicate:
            return "n.path LIKE ?", [str(predicate["prefix"]) + "%"]
        if "glob" in predicate:
            return "n.path GLOB ?", [str(predicate["glob"])]
    warnings.append(FilterWarning(field="path", reason="invalid_predicate"))
    return "", []


def _compile_extra(
    field: str, predicate: Any, warnings: list[FilterWarning]
) -> tuple[str, list[Any]]:
    """`extra.<key>` → json_extract / json_each on notes.extra."""
    key = field.split(".", 1)[1]
    if not key:
        warnings.append(FilterWarning(field=field, reason="invalid_field"))
        return "", []
    json_path = f"$.{key}"
    extracted = f"json_extract(n.extra, '{json_path}')"

    if isinstance(predicate, (str, int, float, bool)):
        # Try equality on either scalar value OR membership in an array.
        return (
            f"({extracted} = ? OR EXISTS "
            f"(SELECT 1 FROM json_each(n.extra, ?) WHERE value = ?))",
            [predicate, json_path, predicate],
        )
    if isinstance(predicate, list) or (isinstance(predicate, dict) and "any" in predicate):
        vals = predicate if isinstance(predicate, list) else (predicate["any"] or [])
        if not vals:
            return "0=1", []
        ph = ",".join(["?"] * len(vals))
        return (
            f"({extracted} IN ({ph}) OR EXISTS "
            f"(SELECT 1 FROM json_each(n.extra, ?) WHERE value IN ({ph})))",
            list(vals) + [json_path] + list(vals),
        )
    if isinstance(predicate, dict):
        if "none" in predicate:
            vals = predicate["none"] or []
            if not vals:
                return "1=1", []
            ph = ",".join(["?"] * len(vals))
            return (
                f"NOT ({extracted} IN ({ph}) OR EXISTS "
                f"(SELECT 1 FROM json_each(n.extra, ?) WHERE value IN ({ph})))",
                list(vals) + [json_path] + list(vals),
            )
        if "is_null" in predicate:
            if predicate["is_null"]:
                return f"{extracted} IS NULL", []
            return f"{extracted} IS NOT NULL", []
    warnings.append(FilterWarning(field=field, reason="invalid_predicate"))
    return "", []


# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------


def _candidate_chunks_sql(where_sql: str, section_prefix: list[str] | None):
    """Return (sql, params_extra) for chunk-id-set after metadata + section filter.

    Section prefix is a JSON-array prefix match: chunks.section_path stored
    as JSON; we use json_extract on each prefix index.
    """
    extra_clauses: list[str] = []
    extra_params: list[Any] = []
    if section_prefix:
        for i, val in enumerate(section_prefix):
            extra_clauses.append(f"json_extract(c.section_path, '$[{i}]') = ?")
            extra_params.append(val)

    where_full = where_sql
    if extra_clauses:
        where_full = where_full + " AND " + " AND ".join(extra_clauses)

    sql = (
        "SELECT c.id FROM chunks c JOIN notes n ON n.id = c.note_id "
        f"WHERE {where_full}"
    )
    return sql, extra_params


def _dense_search(
    conn: sqlite3.Connection,
    query_emb: Any,
    candidate_ids: list[int],
    top_n: int,
) -> list[tuple[int, float]]:
    """vec0 KNN over a candidate id set; returns [(chunk_id, cosine_sim), ...]."""
    if not candidate_ids:
        return []
    import sqlite_vec  # type: ignore[import-not-found]

    blob = sqlite_vec.serialize_float32(list(query_emb))
    ph = ",".join(["?"] * len(candidate_ids))
    rows = conn.execute(
        f"""
        SELECT rowid, distance
        FROM chunks_vec
        WHERE embedding MATCH ? AND rowid IN ({ph})
        ORDER BY distance
        LIMIT ?
        """,
        [blob, *candidate_ids, top_n],
    ).fetchall()
    out: list[tuple[int, float]] = []
    for r in rows:
        # sqlite-vec returns L2 distance for FLOAT[]; for L2-normalized vecs
        # cosine_sim = 1 - dist^2/2. encode() always L2-normalizes (§2 wrapper).
        d = float(r["distance"])
        cos = max(0.0, min(1.0, 1.0 - (d * d) / 2.0))
        out.append((int(r["rowid"]), cos))
    return out


def _bm25_search(
    conn: sqlite3.Connection,
    query_lemmatized: str,
    candidate_ids: list[int],
    top_n: int,
) -> list[tuple[int, float]]:
    """FTS5 MATCH over candidate id set; returns [(chunk_id, normalized), ...]."""
    if not candidate_ids or not query_lemmatized.strip():
        return []
    fts_query = _fts_match_expression(query_lemmatized)
    if not fts_query:
        return []
    ph = ",".join(["?"] * len(candidate_ids))
    rows = conn.execute(
        f"""
        SELECT rowid, bm25(chunks_fts) AS score
        FROM chunks_fts
        WHERE chunks_fts MATCH ? AND rowid IN ({ph})
        ORDER BY score
        LIMIT ?
        """,
        [fts_query, *candidate_ids, top_n],
    ).fetchall()
    out: list[tuple[int, float]] = []
    for r in rows:
        raw = float(r["score"])  # negative; smaller = better
        # §5.3 mapping bm25 → (0..1]
        norm = math.exp(-(-raw) / BM25_SCALE) if raw < 0 else 0.0
        out.append((int(r["rowid"]), norm))
    return out


def _fts_match_expression(query_lemmatized: str) -> str:
    """Quote each token, join with OR — robust against punctuation/operators in user input."""
    tokens = [t for t in query_lemmatized.split() if t]
    if not tokens:
        return ""
    # Escape embedded double-quotes per FTS5 syntax: "" inside "..."
    quoted = ['"' + t.replace('"', '""') + '"' for t in tokens]
    return " OR ".join(quoted)


def _rrf_combine(
    dense_hits: list[tuple[int, float]],
    bm25_hits: list[tuple[int, float]],
) -> dict[int, dict[str, Any]]:
    """RRF combine + per-source rank/score tracking. Returns map[chunk_id → components]."""
    combined: dict[int, dict[str, Any]] = {}
    for rank, (cid, score) in enumerate(dense_hits, start=1):
        combined.setdefault(cid, {})["dense"] = score
        combined[cid]["rrf_rank_dense"] = rank
    for rank, (cid, score) in enumerate(bm25_hits, start=1):
        combined.setdefault(cid, {})["bm25"] = score
        combined[cid]["rrf_rank_bm25"] = rank
    for cid, comp in combined.items():
        rrf = 0.0
        if "rrf_rank_dense" in comp:
            rrf += 1.0 / (K_RRF + comp["rrf_rank_dense"])
        if "rrf_rank_bm25" in comp:
            rrf += 1.0 / (K_RRF + comp["rrf_rank_bm25"])
        comp["rrf_raw"] = rrf
    return combined


def _hydrate_results(
    conn: sqlite3.Connection,
    ranked: list[tuple[int, float, dict[str, Any]]],
) -> list[ChunkResult]:
    if not ranked:
        return []
    ids = [cid for cid, _, _ in ranked]
    ph = ",".join(["?"] * len(ids))
    rows = {
        int(r["id"]): r
        for r in conn.execute(
            f"""
            SELECT c.id, c.note_id, c.ord, c.section_path, c.line_start,
                   c.line_end, c.text, c.frontmatter_prefix,
                   n.path AS note_path,
                   n.type, n.domain, n.note_kind, n.quality, n.stability,
                   n.priority, n.co_authored, n.created, n.updated,
                   n.aliases, n.extra
            FROM chunks c JOIN notes n ON n.id = c.note_id
            WHERE c.id IN ({ph})
            """,
            ids,
        ).fetchall()
    }
    # Tag fetch in one query, grouped per note_id.
    note_ids = {int(r["note_id"]) for r in rows.values()}
    tags_by_note: dict[int, list[str]] = {nid: [] for nid in note_ids}
    if note_ids:
        ph_n = ",".join(["?"] * len(note_ids))
        for r in conn.execute(
            f"SELECT note_id, tag FROM tags WHERE note_id IN ({ph_n})",
            list(note_ids),
        ):
            tags_by_note.setdefault(int(r["note_id"]), []).append(r["tag"])

    import json

    results: list[ChunkResult] = []
    for cid, score, components in ranked:
        r = rows.get(cid)
        if r is None:
            continue
        try:
            sec_path = json.loads(r["section_path"]) if r["section_path"] else []
        except Exception:
            sec_path = []
        try:
            aliases = json.loads(r["aliases"]) if r["aliases"] else []
        except Exception:
            aliases = []
        try:
            extra = json.loads(r["extra"]) if r["extra"] else {}
        except Exception:
            extra = {}

        note_meta = {
            "type": r["type"],
            "domain": r["domain"],
            "note_kind": r["note_kind"],
            "quality": r["quality"],
            "stability": r["stability"],
            "priority": r["priority"],
            "co_authored": r["co_authored"],
            "created": r["created"],
            "updated": r["updated"],
            "aliases": aliases,
            "tags": tags_by_note.get(int(r["note_id"]), []),
            "extra": extra,
        }

        results.append(
            ChunkResult(
                chunk_id=cid,
                note_path=r["note_path"],
                note_id=int(r["note_id"]),
                ord=int(r["ord"]),
                section_path=sec_path,
                line_start=int(r["line_start"]),
                line_end=int(r["line_end"]),
                text=r["text"],
                frontmatter_prefix=r["frontmatter_prefix"],
                score=score,
                score_components=dict(components),
                note_metadata=note_meta,
            )
        )
    return results


# ---------------------------------------------------------------------------
# Public entry
# ---------------------------------------------------------------------------


def search(
    db_path: str,
    query: str,
    *,
    filter: FilterSpec | None = None,
    mode: str = "hybrid",
    k: int = DEFAULT_K,
    section_path_prefix: list[str] | None = None,
    min_score: float | None = None,
    embedding_config: EmbeddingConfig | None = None,
) -> SearchResponse:
    """One-shot search (§5.1)."""
    if not query or not query.strip():
        raise SearchError("EMPTY_QUERY", "query must be a non-empty string")
    if mode not in ("hybrid", "dense", "bm25"):
        raise SearchError(
            "INVALID_MODE", f"mode must be hybrid|dense|bm25, got {mode!r}"
        )

    extra_warnings: list[FilterWarning] = []
    if k > K_CEILING:
        extra_warnings.append(
            FilterWarning(
                field="k", reason="clamped", detail=f"capped at k_ceiling={K_CEILING}"
            )
        )
        k = K_CEILING
    if k < 1:
        k = 1

    started = time.perf_counter()
    cfg_embed = embedding_config or EmbeddingConfig()
    query_lem = lemmatize(query)

    where_sql, where_params, filter_warnings, _ = _filter_to_sql(filter)
    cand_sql, cand_extra = _candidate_chunks_sql(where_sql, section_path_prefix)

    try:
        conn = connect(db_path)
    except sqlite3.OperationalError as exc:
        raise SearchError(
            "INDEX_NOT_INITIALIZED",
            "vault.sqlite is missing or unreadable; run vault_semantic_reindex first.",
            {"detail": str(exc)},
        ) from exc

    try:
        candidate_rows = conn.execute(cand_sql, where_params + cand_extra).fetchall()
        candidate_ids = [int(r["id"]) for r in candidate_rows]
        total_candidates = len(candidate_ids)

        if total_candidates == 0:
            return SearchResponse(
                results=[],
                total_candidates=0,
                query_lemmatized=query_lem,
                mode_used=mode,
                elapsed_ms=int((time.perf_counter() - started) * 1000),
                filter_warnings=filter_warnings + extra_warnings,
            )

        n = max(k * 4, K_RRF)

        dense_hits: list[tuple[int, float]] = []
        bm25_hits: list[tuple[int, float]] = []
        mode_used = mode

        if mode in ("hybrid", "dense"):
            try:
                query_emb = encode([query], query=True, config=cfg_embed)[0]
                dense_hits = _dense_search(conn, query_emb, candidate_ids, n)
            except EmbeddingUnavailable as exc:
                if mode == "dense":
                    raise SearchError(
                        "EMBEDDING_MODEL_UNAVAILABLE", str(exc)
                    ) from exc
                # hybrid → fall back to bm25-only.
                extra_warnings.append(
                    FilterWarning(
                        field="mode",
                        reason="dense_fallback_bm25",
                        detail=str(exc),
                    )
                )

        if mode in ("hybrid", "bm25"):
            bm25_hits = _bm25_search(conn, query_lem, candidate_ids, n)

        # Rank assembly per mode.
        if mode == "dense" or (mode == "hybrid" and not bm25_hits and dense_hits):
            ranked = [
                (cid, score, {"dense": score})
                for cid, score in dense_hits[:k]
            ]
            if mode == "hybrid" and not bm25_hits:
                mode_used = "dense"
        elif mode == "bm25" or (mode == "hybrid" and not dense_hits and bm25_hits):
            ranked = [
                (cid, score, {"bm25": score})
                for cid, score in bm25_hits[:k]
            ]
            if mode == "hybrid" and not dense_hits:
                mode_used = "bm25"
        else:  # hybrid both populated, OR both empty
            combined = _rrf_combine(dense_hits, bm25_hits)
            # Normalize: max RRF when rank=1 in BOTH lists = 2/(K_RRF+1).
            denom = 2.0 / (K_RRF + 1)
            ranked_pairs = sorted(
                combined.items(),
                key=lambda kv: kv[1].get("rrf_raw", 0.0),
                reverse=True,
            )[:k]
            ranked = [
                (cid, comp["rrf_raw"] / denom, comp)
                for cid, comp in ranked_pairs
            ]

        if min_score is not None:
            ranked = [(cid, s, c) for cid, s, c in ranked if s >= min_score]

        results = _hydrate_results(conn, ranked)
    finally:
        conn.close()

    return SearchResponse(
        results=results,
        total_candidates=total_candidates,
        query_lemmatized=query_lem,
        mode_used=mode_used,
        elapsed_ms=int((time.perf_counter() - started) * 1000),
        filter_warnings=filter_warnings + extra_warnings,
    )
