"""Russian + English lemmatization for FTS5.

Lemmatize-at-index strategy per RAG_Architecture.md §4.3: every text destined
for FTS5 (chunks at index time, query string at search time) goes through this
function so that FTS5's `unicode61` tokenizer matches normalized forms.

Pipeline per token:
  1. Lowercase.
  2. Cyrillic → pymorphy3 normal_form.
  3. Pure-Latin alpha → snowball English stem.
  4. Anything else (digits, mixed alphanumeric) → kept lowercased.

pymorphy3 dictionary load is ~100 MB, so analyzers are lazy-init singletons.
"""

from __future__ import annotations

import re
from functools import lru_cache
from typing import Any

# Token = maximal run of unicode letters/digits (`\w` minus underscore).
# Splitting on `_` is intentional: it makes `Amanita_Phalloides` two tokens,
# matching how WikiLink targets read in prose queries.
_TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)
_CYRILLIC_RE = re.compile(r"[а-яёА-ЯЁ]")

_morph: Any = None
_en_stemmer: Any = None


def _get_morph() -> Any:
    global _morph
    if _morph is None:
        import pymorphy3

        _morph = pymorphy3.MorphAnalyzer()
    return _morph


def _get_en_stemmer() -> Any:
    global _en_stemmer
    if _en_stemmer is None:
        import snowballstemmer

        _en_stemmer = snowballstemmer.stemmer("english")
    return _en_stemmer


@lru_cache(maxsize=50_000)
def _normalize_token(token: str) -> str:
    token = token.lower()
    if not token:
        return token
    if _CYRILLIC_RE.search(token):
        return _get_morph().parse(token)[0].normal_form
    if token.isalpha():
        return _get_en_stemmer().stemWord(token)
    return token


def lemmatize(text: str) -> str:
    """Normalize free text for FTS5 indexing/querying.

    Same function MUST be used at index and query time — the FTS5 column stores
    already-normalized forms (chunks.text_lemmatized) and matching is purely
    string-based after unicode61 tokenization.
    """
    if not text:
        return ""
    return " ".join(_normalize_token(t) for t in _TOKEN_RE.findall(text))
