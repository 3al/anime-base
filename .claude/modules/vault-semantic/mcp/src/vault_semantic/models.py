"""Public data shapes returned by the MCP tools.

Schema is the contract from RAG_Architecture.md §5.1 (`SearchResponse`,
`ChunkResult`) + §6.4 (`FilterWarning`). `FilterSpec` is intentionally a
plain JSON-serializable `dict` — it lands as a kwarg on the tool, comes from
the LLM router as JSON, and is shaped per §6 — keeping it as `dict` avoids a
parsing layer that would otherwise reject malformed input the §6.4 policy
deliberately wants to tolerate (warn-and-ignore, not reject).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


FilterSpec = dict[str, Any]


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

    def to_dict(self) -> dict[str, Any]:
        return {
            "chunk_id": self.chunk_id,
            "note_path": self.note_path,
            "note_id": self.note_id,
            "ord": self.ord,
            "section_path": list(self.section_path),
            "line_start": self.line_start,
            "line_end": self.line_end,
            "text": self.text,
            "frontmatter_prefix": self.frontmatter_prefix,
            "score": self.score,
            "score_components": dict(self.score_components),
            "note_metadata": dict(self.note_metadata),
        }


@dataclass
class SearchResponse:
    """Top-level response of `vault_semantic_search`."""

    results: list[ChunkResult]
    total_candidates: int
    query_lemmatized: str
    mode_used: str
    elapsed_ms: int
    filter_warnings: list[FilterWarning] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "results": [r.to_dict() for r in self.results],
            "total_candidates": self.total_candidates,
            "query_lemmatized": self.query_lemmatized,
            "mode_used": self.mode_used,
            "elapsed_ms": self.elapsed_ms,
            "filter_warnings": [w.to_dict() for w in self.filter_warnings],
        }
