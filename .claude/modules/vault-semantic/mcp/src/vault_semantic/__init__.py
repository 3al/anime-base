"""vault-semantic — semantic search MCP server for Obsidian vaults.

See docs/RAG_Architecture.md in vault-bootstrap for full architecture.
"""

from importlib.metadata import PackageNotFoundError, version as _pkg_version

try:
    __version__ = _pkg_version("vault-semantic")
except PackageNotFoundError:
    # Package metadata is unavailable only when the source tree is imported
    # without `pip install -e` (e.g. running tests directly against src/).
    # Production install path always goes through pip, so the marker is safe.
    __version__ = "0.0.0+source"
