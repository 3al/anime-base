"""Markdown-aware chunking + frontmatter prefix composition.

Implements the chunking pipeline from RAG_Architecture.md §3:
  body → split into H1/H2/H3 sections → Chonkie RecursiveChunker → emit Chunks.

Two layers, intentionally separated for testability:

  * Pure-Python (no heavy deps):
      - Section walker (`_split_into_sections`) — heading stack + line tracking,
        code-fence aware so `#` inside fences is not mistaken for a heading.
      - Prefix composers (`compose_note_prefix`, `compose_chunk_prefix`).
      - `chunk_note(...)` orchestration.

  * Chonkie integration (lazy):
      - `_get_chunker(config)` instantiates a `RecursiveChunker` with the
        bge-m3 tokenizer. Imported only when actually chunking real text;
        keeps unit tests of section walker / prefix composer fast.

Storage contract per §3.3:
  * `Chunk.frontmatter_prefix` — full prefix block including `[section]` line,
    no `---` separator, no body.
  * `Chunk.text` — body only.
  * Encoder & lemmatizer input — `prefix + "\\n---\\n" + text` (caller's job).
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any, Iterable


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------


@dataclass
class ChunkerConfig:
    """Per-vault overrides land here via manifest config block (§3.2)."""

    chunk_size: int = 600
    chunk_overlap: int = 80
    min_chunk_size: int = 150
    max_chunk_size: int = 1200
    tokenizer: str = "BAAI/bge-m3"


@dataclass
class NoteMeta:
    """Inputs to `compose_note_prefix` — ordering matches §3.3 prefix template.

    Empty/None fields render to omitted lines (or omitted segments inside
    `[meta]`).
    """

    path: str  # POSIX-relative, e.g. "MUSHROOM/Lepiota_Magnispora.md"
    type: str | None = None
    domain: str | None = None
    note_kind: str | None = None
    quality: str | None = None
    stability: str | None = None
    priority: str | None = None
    co_authored: str | None = None
    tags: list[str] = field(default_factory=list)
    aliases: list[str] = field(default_factory=list)


@dataclass
class Chunk:
    """A single emitted chunk, ready for indexer INSERT.

    Line numbers are 1-based and inclusive. `ord` is 0-based across the note.
    `hash` is blake2b-128 over `text` only (prefix is metadata, not content).
    """

    ord: int
    text: str
    frontmatter_prefix: str
    section_path: list[str]
    line_start: int
    line_end: int
    hash: str

    @property
    def section_path_json(self) -> str:
        return json.dumps(self.section_path, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Regexes
# ---------------------------------------------------------------------------

# ATX heading at line start: 1–6 `#`, mandatory space, capture level + text.
# Trailing `#` decoration (CommonMark) is stripped.
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")

# Fenced code block boundary — ``` or ~~~ with optional info string.
_FENCE_RE = re.compile(r"^(```+|~~~+)")


# ---------------------------------------------------------------------------
# Section walker (pure Python)
# ---------------------------------------------------------------------------


@dataclass
class _Section:
    """Internal type — body of one H1/H2/H3 section + its heading stack."""

    section_path: list[str]
    text: str  # body of section, without the heading line itself
    line_start: int  # 1-based, line number of first body line in original file
    # line_end is implicit via len(text.splitlines())


def _split_into_sections(body: str, title: str | None) -> list[_Section]:
    """Walk body line-by-line; emit a section per H1/H2/H3 boundary.

    H1 that matches `title` is excluded from `section_path` (§3.4) — typical
    Obsidian vault has the title in the filename, not a body H1, but we handle
    the case where authors do put a top-level H1.
    """
    lines = body.splitlines()
    sections: list[_Section] = []
    stack: list[tuple[int, str]] = []  # [(level, text), ...] for current path
    cur_lines: list[str] = []
    cur_path: list[str] = []
    cur_start = 1  # 1-based line of the first line in cur_lines
    in_fence = False

    def flush() -> None:
        if not cur_lines:
            return
        # Strip leading/trailing blank lines so empty sections are dropped.
        while cur_lines and not cur_lines[0].strip():
            cur_lines.pop(0)
        while cur_lines and not cur_lines[-1].strip():
            cur_lines.pop()
        if not cur_lines:
            return
        sections.append(
            _Section(
                section_path=list(cur_path),
                text="\n".join(cur_lines),
                line_start=cur_start,
            )
        )

    i = 0
    while i < len(lines):
        line = lines[i]
        line_no = i + 1  # 1-based

        if _FENCE_RE.match(line):
            in_fence = not in_fence
            cur_lines.append(line)
            i += 1
            continue

        m = None if in_fence else _HEADING_RE.match(line)
        if m and len(m.group(1)) <= 3:
            # H1/H2/H3 — hard boundary.
            flush()
            level = len(m.group(1))
            text = m.group(2).strip()
            # Pop stack to the parent of this level.
            while stack and stack[-1][0] >= level:
                stack.pop()
            # H1 == title → don't push.
            push = not (level == 1 and title is not None and text == title)
            if push:
                stack.append((level, text))
            cur_path = [t for _, t in stack]
            cur_lines = []
            cur_start = line_no + 1  # body starts on the next line
            i += 1
            continue

        # H4+ headings or regular content — stays inside current section.
        cur_lines.append(line)
        i += 1

    flush()
    return sections


# ---------------------------------------------------------------------------
# Prefix composition (pure Python)
# ---------------------------------------------------------------------------


_META_FIELDS_ORDER = (
    "type",
    "domain",
    "note_kind",
    "quality",
    "stability",
    "priority",
    "co_authored",
)


def compose_note_prefix(meta: NoteMeta) -> str:
    """Build per-note prefix lines: [note] / [meta] / [tags] / [aliases].

    The `[section]` line is added per chunk by `compose_chunk_prefix`.
    Empty fields are omitted. Multiple consecutive blank lines are not
    produced — each line is non-empty by construction.
    """
    lines: list[str] = [f"[note] path: {meta.path}"]

    meta_parts: list[str] = []
    for fname in _META_FIELDS_ORDER:
        val = getattr(meta, fname)
        if val:
            meta_parts.append(f"{fname}={val}")
    if meta_parts:
        lines.append(f"[meta] {' | '.join(meta_parts)}")

    if meta.tags:
        lines.append(f"[tags] {', '.join(meta.tags)}")
    if meta.aliases:
        lines.append(f"[aliases] {', '.join(meta.aliases)}")

    return "\n".join(lines)


def compose_chunk_prefix(note_prefix: str, section_path: list[str]) -> str:
    """Append `[section]` line to note-level prefix when path is non-empty."""
    if not section_path:
        return note_prefix
    return f"{note_prefix}\n[section] {' > '.join(section_path)}"


# ---------------------------------------------------------------------------
# Chonkie wrapper (lazy)
# ---------------------------------------------------------------------------


_CHUNKER_CACHE: dict[tuple[str, int, int, int, int], Any] = {}


def _get_chunker(config: ChunkerConfig) -> Any:
    """Instantiate (or fetch cached) Chonkie `RecursiveChunker` with bge-m3 tokenizer.

    Cached by (tokenizer, chunk_size, overlap, min, max) — config changes →
    new chunker. The transformers tokenizer load is the slow part (~1s) and
    irrelevant to per-note cost once warm.
    """
    key = (
        config.tokenizer,
        config.chunk_size,
        config.chunk_overlap,
        config.min_chunk_size,
        config.max_chunk_size,
    )
    cached = _CHUNKER_CACHE.get(key)
    if cached is not None:
        return cached

    from chonkie import RecursiveChunker  # type: ignore[import-not-found]
    from transformers import AutoTokenizer  # type: ignore[import-not-found]

    tokenizer = AutoTokenizer.from_pretrained(config.tokenizer)
    chunker = RecursiveChunker(
        tokenizer=tokenizer,
        chunk_size=config.chunk_size,
        min_characters_per_chunk=max(1, config.min_chunk_size // 4),
    )
    _CHUNKER_CACHE[key] = chunker
    return chunker


def _sub_chunk(section: _Section, chunker: Any) -> Iterable[tuple[str, int]]:
    """Run Chonkie on a section body, yield (chunk_text, line_offset_within_section).

    Chonkie chunks expose `start_index`/`end_index` (char offsets in input).
    We translate `start_index` to a line offset by counting newlines.
    """
    if not section.text.strip():
        return
    chonk_chunks = chunker.chunk(section.text)
    for c in chonk_chunks:
        start = getattr(c, "start_index", 0) or 0
        line_off = section.text.count("\n", 0, start)
        yield (c.text, line_off)


# ---------------------------------------------------------------------------
# Hash + line-range helper
# ---------------------------------------------------------------------------


def _hash_text(text: str) -> str:
    return hashlib.blake2b(text.encode("utf-8"), digest_size=16).hexdigest()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def chunk_note(
    body: str,
    *,
    note_prefix: str,
    title: str | None = None,
    config: ChunkerConfig | None = None,
    chunker: Any | None = None,
) -> list[Chunk]:
    """Top-level: body → list[Chunk].

    `body` must already have YAML frontmatter stripped (indexer's job).
    `note_prefix` is `compose_note_prefix(meta)`. `title` is used to filter
    H1==title from section_path. `chunker` injectable for tests; otherwise
    `_get_chunker(config)` is called lazily.

    Edge cases per §3.6:
      * Empty / whitespace-only body → [].
      * Body smaller than min_chunk_size (in chars-as-proxy) → single chunk
        whose section_path is the path at the body start (typically []).
      * Each H1/H2/H3 section is independently sub-chunked; chunks of
        different sections are NEVER merged (note-ownership preserved).
    """
    cfg = config or ChunkerConfig()
    if not body.strip():
        return []

    sections = _split_into_sections(body, title)
    if not sections:
        return []

    # Cheap path: tiny body → one chunk, skip Chonkie load entirely.
    total_chars = sum(len(s.text) for s in sections)
    if total_chars < cfg.min_chunk_size and len(sections) == 1:
        s = sections[0]
        line_count = s.text.count("\n")
        chunk_prefix = compose_chunk_prefix(note_prefix, s.section_path)
        return [
            Chunk(
                ord=0,
                text=s.text,
                frontmatter_prefix=chunk_prefix,
                section_path=s.section_path,
                line_start=s.line_start,
                line_end=s.line_start + line_count,
                hash=_hash_text(s.text),
            )
        ]

    if chunker is None:
        chunker = _get_chunker(cfg)

    out: list[Chunk] = []
    ord_ = 0
    for s in sections:
        chunk_prefix = compose_chunk_prefix(note_prefix, s.section_path)
        for text, line_off in _sub_chunk(s, chunker):
            line_start = s.line_start + line_off
            line_end = line_start + text.count("\n")
            out.append(
                Chunk(
                    ord=ord_,
                    text=text,
                    frontmatter_prefix=chunk_prefix,
                    section_path=s.section_path,
                    line_start=line_start,
                    line_end=line_end,
                    hash=_hash_text(text),
                )
            )
            ord_ += 1

    return out
