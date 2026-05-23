"""sentence-transformers wrapper for the embedding pipeline.

Implements the contract from RAG_Architecture.md §2:
  * Lazy singleton — model loads on first `get_model()` call, lives in
    process memory until MCP shutdown (§2.1).
  * Device auto-detect (cuda > mps > cpu) with override (§2.3).
  * Batch encoding with L2-normalized output (§2.4 — batch=32 indexing,
    batch=1 query).
  * HF cache location respected via the standard `HF_HOME` env var; harness
    sets it from `config.hf_cache_dir` (§2.2). This module reads the env,
    not the manifest.
  * Offline-mode guard (§2.2): if `TRANSFORMERS_OFFLINE=1` /
    `HF_HUB_OFFLINE=1` and the model isn't cached, raise
    `EmbeddingUnavailable` with an actionable message instead of letting the
    transformers stacktrace bubble up.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any


@dataclass
class EmbeddingConfig:
    model: str = "BAAI/bge-m3"
    device: str = "auto"  # 'auto' | 'cpu' | 'cuda' | 'mps'
    batch_size: int = 32
    revision: str | None = None  # HF revision pin (commit SHA / tag)


class EmbeddingUnavailable(RuntimeError):
    """Surfaces as EMBEDDING_MODEL_UNAVAILABLE error in MCP tool responses."""


_MODEL_CACHE: dict[tuple[str, str, str | None], Any] = {}


def detect_device(override: str | None = None) -> str:
    """`override='auto'` or `None` → probe torch; otherwise return as-is."""
    if override and override != "auto":
        return override
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        # `torch.backends.mps` exists only on macOS builds.
        mps = getattr(torch.backends, "mps", None)
        if mps is not None and mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def get_model(config: EmbeddingConfig | None = None) -> Any:
    """Load (or return cached) `SentenceTransformer` instance.

    Cache key includes model+device+revision so reconfiguring at runtime
    doesn't return a stale model. In normal MCP lifetime there's exactly
    one entry — the singleton.
    """
    cfg = config or EmbeddingConfig()
    device = detect_device(cfg.device)
    key = (cfg.model, device, cfg.revision)

    cached = _MODEL_CACHE.get(key)
    if cached is not None:
        return cached

    from sentence_transformers import SentenceTransformer  # type: ignore[import-not-found]

    kwargs: dict[str, Any] = {"device": device}
    if cfg.revision:
        kwargs["revision"] = cfg.revision

    try:
        model = SentenceTransformer(cfg.model, **kwargs)
    except Exception as exc:
        if _is_offline() and _looks_like_cache_miss(exc):
            hf_home = os.environ.get("HF_HOME", "<unset>")
            raise EmbeddingUnavailable(
                f"Offline mode active (TRANSFORMERS_OFFLINE/HF_HUB_OFFLINE=1) "
                f"but model '{cfg.model}' is not in HF cache (HF_HOME={hf_home}). "
                f"Run a one-time online warmup or unset offline flags."
            ) from exc
        raise

    _MODEL_CACHE[key] = model
    return model


def encode(
    texts: list[str],
    *,
    query: bool = False,
    config: EmbeddingConfig | None = None,
) -> Any:
    """Embed texts → L2-normalized numpy array of shape (N, dim).

    `query=True` switches batch_size to 1 (query path is single-string by
    construction; matches §2.4). bge-m3 itself doesn't need a query/passage
    prefix; if a future model in §2.6 requires one, that wrapping happens
    here, not at callsites.
    """
    cfg = config or EmbeddingConfig()
    model = get_model(cfg)
    return model.encode(
        texts,
        batch_size=1 if query else cfg.batch_size,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )


def get_embedding_dim(config: EmbeddingConfig | None = None) -> int:
    """Used by indexer at startup to verify schema dim matches configured model (§2.6)."""
    return int(get_model(config).get_sentence_embedding_dimension())


def _is_offline() -> bool:
    return (
        os.environ.get("TRANSFORMERS_OFFLINE") == "1"
        or os.environ.get("HF_HUB_OFFLINE") == "1"
    )


def _looks_like_cache_miss(exc: BaseException) -> bool:
    """Heuristic: HF raises various exception types for cache miss in offline mode.

    Rather than match a specific class (which differs across hf-hub versions),
    we look for the strings transformers/hf-hub use in their error messages.
    """
    msg = str(exc).lower()
    return any(
        marker in msg
        for marker in (
            "offline",
            "not found in the local cache",
            "couldn't find",
            "no such file",
            "connection",
        )
    )
