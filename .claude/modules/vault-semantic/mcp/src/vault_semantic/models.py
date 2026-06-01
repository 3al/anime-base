"""Public data shapes returned by the MCP tools.

Schema is the contract from RAG_Architecture.md §5.1 (`SearchResponse`,
`ChunkResult`) + §6.4 (`FilterWarning`). `FilterSpec` is intentionally a
plain JSON-serializable `dict` — it lands as a kwarg on the tool, comes from
the LLM router as JSON, and is shaped per §6 — keeping it as `dict` avoids a
parsing layer that would otherwise reject malformed input the §6.4 policy
deliberately wants to tolerate (warn-and-ignore, not reject).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


FilterSpec = dict[str, Any]


# ---------------------------------------------------------------------------
# Response-size budget (v0.5.0) — threshold (B) "size the server EMITS".
#
# Distinct from the harness per-tool-result token cap (A), which this module
# does NOT control. We keep (B) small by construction so (A) rarely triggers;
# the rare overflow remains a graceful spill-to-file path, not a failure.
# These are server-side constants today; once core grows a runtime-config
# passing mechanism (config.vault-semantic.* → mcp_server.env), they become
# the floors that config defaults can raise/lower per `module.yaml`.
# ---------------------------------------------------------------------------

RESPONSE_VERBOSITY_DEFAULT = "lean"   # 'lean' | 'full'
# v0.5.1: the budget is counted in UTF-8 *bytes*, not str-chars. The harness
# per-tool-result cap is byte/token-based; for Cyrillic 1 char = 2 bytes, so a
# char-counted budget under-measured the real envelope by ~1.7x and still
# overflowed (Anime_Base: 40k-char budget → 68 KB on disk → spill). Bytes map
# to the cap uniformly across languages (ASCII ≈ chars; Cyrillic ~2× chars).
# The public arg / config knob keep the name `response_max_chars` for API
# continuity — the value is a byte budget.
RESPONSE_MAX_CHARS_DEFAULT = 40_000   # byte budget ≈ fits one in-context tool-result
RESPONSE_MAX_CHARS_FLOOR = 2_000      # below this a single record can't fit
RESPONSE_MAX_CHARS_CEILING = 200_000  # anti-runaway clamp on per-call override


@dataclass
class FilterWarning:
    """One degraded-but-not-fatal issue found while parsing a `FilterSpec`."""

    field: str
    reason: str  # 'unknown_field' | 'unsupported_predicate' | 'invalid_value' | ...
    detail: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"field": self.field, "reason": self.reason, "detail": self.detail}


@dataclass
class ChunkResult:
    """One retrieved chunk + its scoring breakdown."""

    chunk_id: int
    note_path: str
    note_id: int
    ord: int
    section_path: list[str]
    line_start: int
    line_end: int
    text: str
    frontmatter_prefix: str
    score: float
    score_components: dict[str, Any]
    note_metadata: dict[str, Any]

    def to_dict(
        self, *, verbosity: str = RESPONSE_VERBOSITY_DEFAULT, header_only: bool = False
    ) -> dict[str, Any]:
        """Serialize one chunk.

        `header_only=True` emits the minimal locator (note_path + section_path
        + score) with no text/metadata — used for the tail of an over-budget
        response so the caller can still see *which* notes ranked, then read
        them directly if needed (§2 response budget).

        `verbosity`:
          * ``lean`` (default) — text + note_metadata MINUS `extra`. The `extra`
            blob is the full card frontmatter (staff/aliases/urls/images …) and
            in 0.5.0 it was the dominant remaining payload weight, repeated
            verbatim on every chunk of the same note (v0.5.1 fix). The router
            has `note_path` + the scalar fields and reads the card directly when
            it needs `extra`. Dropping it never affects ranking.
          * ``full`` — keeps `extra` and additionally includes `score_components`
            (dense/bm25/rrf ranks). `frontmatter_prefix` is intentionally never
            serialized: it is a second serialization of the same data already in
            `note_metadata`, kept only for indexing (see RAG §5.1).
        """
        if header_only:
            return {
                "chunk_id": self.chunk_id,
                "note_path": self.note_path,
                "section_path": list(self.section_path),
                "score": self.score,
                "header_only": True,
            }
        note_meta = dict(self.note_metadata)
        if verbosity != "full":
            note_meta.pop("extra", None)
        d: dict[str, Any] = {
            "chunk_id": self.chunk_id,
            "note_path": self.note_path,
            "note_id": self.note_id,
            "ord": self.ord,
            "section_path": list(self.section_path),
            "line_start": self.line_start,
            "line_end": self.line_end,
            "text": self.text,
            "score": self.score,
            "note_metadata": note_meta,
        }
        if verbosity == "full":
            d["score_components"] = dict(self.score_components)
        return d


@dataclass
class SearchResponse:
    """Top-level response of `vault_semantic_search`."""

    results: list[ChunkResult]
    total_candidates: int
    query_lemmatized: str
    mode_used: str
    elapsed_ms: int
    filter_warnings: list[FilterWarning] = field(default_factory=list)

    def to_dict(
        self,
        *,
        verbosity: str = RESPONSE_VERBOSITY_DEFAULT,
        max_chars: int | None = RESPONSE_MAX_CHARS_DEFAULT,
    ) -> dict[str, Any]:
        """Serialize the response under a total UTF-8 *byte* budget (threshold B).

        v0.5.1: the budget counts the FULL serialized record (text + metadata)
        in UTF-8 bytes — the unit that maps to the harness per-tool-result cap.
        0.5.0 counted str-chars, which under-measured non-ASCII envelopes (1
        Cyrillic char = 2 bytes) so `bounded` reported clear while the on-disk
        result still overflowed. `max_chars` is therefore a byte budget despite
        the name (kept for API continuity).

        Ranking is untouched — results keep their order. The budget only decides
        where full records stop: top chunks emit full records (per `verbosity`),
        the remainder degrade to header-only locators. The top-1 record is always
        emitted in full even if it alone exceeds the budget (a single oversized
        chunk is the legitimate spill-to-file path the skill handles by reading
        from disk).

        `max_chars=None` disables the budget (every record full — used by
        callers that explicitly opted into a larger payload).
        """
        meta = {
            "total_candidates": self.total_candidates,
            "query_lemmatized": self.query_lemmatized,
            "mode_used": self.mode_used,
            "elapsed_ms": self.elapsed_ms,
            "filter_warnings": [w.to_dict() for w in self.filter_warnings],
        }

        def _bytes(obj: Any) -> int:
            return len(json.dumps(obj, ensure_ascii=False).encode("utf-8"))

        results_out: list[dict[str, Any]] = []
        full_count = 0
        # Account for the fixed wrapper overhead before spending on records.
        used = _bytes({**meta, "results": [], "payload": {}})
        if max_chars is None:
            for r in self.results:
                rec = r.to_dict(verbosity=verbosity)
                results_out.append(rec)
                used += _bytes(rec) + 1
                full_count += 1
        else:
            for r in self.results:
                rec = r.to_dict(verbosity=verbosity)
                rec_len = _bytes(rec) + 1  # +comma
                if full_count == 0 or used + rec_len <= max_chars:
                    results_out.append(rec)
                    used += rec_len
                    full_count += 1
                else:
                    hdr = r.to_dict(header_only=True)
                    results_out.append(hdr)
                    used += _bytes(hdr) + 1

        out: dict[str, Any] = {"results": results_out}
        out.update(meta)
        out["payload"] = {
            "verbosity": verbosity,
            "full_text_count": full_count,
            "header_only_count": len(self.results) - full_count,
            "bounded": max_chars is not None and full_count < len(self.results),
            "max_chars": max_chars,
            "budget_unit": "utf8_bytes",
            "approx_bytes": used,
        }
        return out
