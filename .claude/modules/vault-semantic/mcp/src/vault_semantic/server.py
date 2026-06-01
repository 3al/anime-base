"""MCP server entry point — wires search/reindex/stats/warmup tools.

Tool surface per RAG_Architecture.md §5.1 and §5.5:
  * `vault_semantic_search`  (§5.1)
  * `vault_semantic_reindex` (§5.5)
  * `vault_semantic_stats`   (§5.5)
  * `vault_semantic_warmup`  (§2.1, optional helper)

Transport selection (Phase 4.7 — Windows stdio MSVCRT-buffering workaround):
  * If ``MCP_HTTP_PORT`` env is set → streamable-http on 127.0.0.1:$PORT,
    stateless mode (no SSE, no session tracking — every POST is independent
    JSON-RPC). Used in normal Claude Code registration via Node stdio-shim
    (see ``shim/index.mjs``). Eliminates Python stdio entirely.
  * Otherwise → stdio (back-compat for Linux/Mac, direct CLI testing).

Required env: ``VAULT_ROOT``. Optional env: ``HF_HOME`` (HF cache root, set
by harness from `config.hf_cache_dir`), ``TRANSFORMERS_OFFLINE``,
``MCP_HTTP_PORT``, ``MCP_HTTP_HOST`` (default 127.0.0.1).

DB path is fixed per §4: ``$VAULT_ROOT/.claude/modules/vault-semantic/data/vault.sqlite``.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from . import __version__
from .embedding import EmbeddingConfig, get_embedding_dim
from .indexer import connect, ensure_fresh_safe, reindex
from .models import (
    RESPONSE_MAX_CHARS_CEILING,
    RESPONSE_MAX_CHARS_DEFAULT,
    RESPONSE_MAX_CHARS_FLOOR,
    RESPONSE_VERBOSITY_DEFAULT,
)
from .search import DEFAULT_K, K_HARD_CAP, SearchError, search


_DB_RELATIVE = Path(".claude") / "modules" / "vault-semantic" / "data" / "vault.sqlite"


def _vault_root() -> Path:
    root = os.environ.get("VAULT_ROOT")
    if not root:
        print("ERROR: VAULT_ROOT env var required.", file=sys.stderr)
        sys.exit(2)
    return Path(root).resolve()


def _db_path() -> Path:
    return _vault_root() / _DB_RELATIVE


def _error(code: str, message: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    """Uniform error envelope. FastMCP returns it to the caller as the tool
    result; the LLM router (and tests) inspect `error.code` per §5.7."""
    err: dict[str, Any] = {"code": code, "message": message}
    if data:
        err["data"] = data
    return {"error": err}


_http_port_env = os.environ.get("MCP_HTTP_PORT")
_http_mode = bool(_http_port_env)

if _http_mode:
    server = FastMCP(
        "vault-semantic",
        host=os.environ.get("MCP_HTTP_HOST", "127.0.0.1"),
        port=int(_http_port_env),  # type: ignore[arg-type]
        stateless_http=True,
        json_response=True,
    )
else:
    server = FastMCP("vault-semantic")


@server.tool()
def vault_semantic_search(
    query: str,
    filter: dict | None = None,
    mode: str = "hybrid",
    k: int = DEFAULT_K,
    section_path_prefix: list[str] | None = None,
    min_score: float | None = None,
    verbosity: str = RESPONSE_VERBOSITY_DEFAULT,
    response_max_chars: int | None = None,
) -> dict:
    """Hybrid semantic + BM25 search across the vault. See §5.1 for the
    parameter shapes and §6 for the `filter` dialect.

    Payload-size controls (v0.5.0) — these bound what the server EMITS so it
    fits one in-context tool-result; they do NOT touch ranking:
      * `verbosity`: 'lean' (default) | 'full'. 'full' adds debug
        `score_components` per chunk. Unknown values fall back to 'lean'.
      * `response_max_chars`: total serialized-char budget. Top chunks emit
        full records, the remainder degrade to header-only locators. Defaults
        to RESPONSE_MAX_CHARS_DEFAULT; per-call overrides are clamped to
        [RESPONSE_MAX_CHARS_FLOOR, RESPONSE_MAX_CHARS_CEILING].
    `k` is clamped to K_CEILING inside `search()`.
    """
    if verbosity not in ("lean", "full"):
        verbosity = RESPONSE_VERBOSITY_DEFAULT
    if response_max_chars is None:
        response_max_chars = RESPONSE_MAX_CHARS_DEFAULT
    else:
        response_max_chars = max(
            RESPONSE_MAX_CHARS_FLOOR,
            min(int(response_max_chars), RESPONSE_MAX_CHARS_CEILING),
        )

    ensure_fresh_safe(_vault_root(), _db_path())
    try:
        resp = search(
            db_path=str(_db_path()),
            query=query,
            filter=filter,
            mode=mode,
            k=k,
            section_path_prefix=section_path_prefix,
            min_score=min_score,
        )
    except SearchError as exc:
        return _error(exc.code, str(exc), exc.data)
    except Exception as exc:  # noqa: BLE001
        return _error("INTERNAL_ERROR", str(exc))
    return resp.to_dict(verbosity=verbosity, max_chars=response_max_chars)


@server.tool()
def vault_semantic_reindex(scope: str = "changed", dry_run: bool = False) -> dict:
    """Walk vault → upsert chunks/embeddings/FTS rows. See §4.5 for semantics."""
    try:
        stats = reindex(
            vault_root=_vault_root(),
            db_path=_db_path(),
            scope=scope,
            dry_run=dry_run,
        )
    except FileNotFoundError as exc:
        return _error("VAULT_ROOT_MISSING", str(exc))
    except RuntimeError as exc:
        return _error("INDEX_ERROR", str(exc))
    except Exception as exc:  # noqa: BLE001
        return _error("INTERNAL_ERROR", str(exc))
    return stats.to_dict()


@server.tool()
def vault_semantic_stats() -> dict:
    """Index health snapshot for UI / debugging. See §5.5."""
    ensure_fresh_safe(_vault_root(), _db_path())
    db = _db_path()
    if not db.exists():
        return _error(
            "INDEX_NOT_INITIALIZED",
            "vault.sqlite missing; run vault_semantic_reindex first.",
            {"expected_path": str(db)},
        )

    try:
        conn = connect(db)
    except Exception as exc:  # noqa: BLE001
        return _error("INTERNAL_ERROR", str(exc))

    try:
        notes_total = int(
            (conn.execute("SELECT COUNT(*) AS c FROM notes").fetchone() or {"c": 0})["c"]
        )
        chunks_total = int(
            (conn.execute("SELECT COUNT(*) AS c FROM chunks").fetchone() or {"c": 0})["c"]
        )
        last_row = conn.execute(
            "SELECT MAX(indexed_at) AS m FROM notes"
        ).fetchone()
        last_indexed = int(last_row["m"]) if last_row and last_row["m"] else None
        ver_row = conn.execute(
            "SELECT MAX(version) AS v FROM schema_version"
        ).fetchone()
        schema_version = int(ver_row["v"]) if ver_row and ver_row["v"] else 0

        # Pull dim out of stored DDL for chunks_vec — avoid loading the model.
        ddl_row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE name = 'chunks_vec'"
        ).fetchone()
        emb_dim = 0
        if ddl_row and ddl_row["sql"]:
            import re

            m = re.search(r"FLOAT\s*\[\s*(\d+)\s*\]", ddl_row["sql"], re.IGNORECASE)
            if m:
                emb_dim = int(m.group(1))
    finally:
        conn.close()

    cfg = EmbeddingConfig()
    return {
        "notes_total": notes_total,
        "chunks_total": chunks_total,
        "db_size_bytes": int(db.stat().st_size),
        "last_indexed_at": last_indexed,
        "embedding_model": cfg.model,
        "embedding_dim": emb_dim,
        "tokenizer_strategy": "lemmatize-at-index",
        "schema_version": schema_version,
        "version": __version__,
    }


@server.tool()
def vault_semantic_warmup() -> dict:
    """Force-load the embedding model to surface download / load issues
    explicitly rather than at the first search call. See §2.1."""
    try:
        dim = get_embedding_dim()
    except Exception as exc:  # noqa: BLE001
        return _error("EMBEDDING_MODEL_UNAVAILABLE", str(exc))
    return {"status": "ready", "embedding_dim": dim, "version": __version__}


def main() -> None:
    _vault_root()
    # K_HARD_CAP referenced for tooling sanity (lints stay green).
    _ = K_HARD_CAP
    if _http_mode:
        server.run(transport="streamable-http")
    else:
        server.run()


if __name__ == "__main__":
    main()
