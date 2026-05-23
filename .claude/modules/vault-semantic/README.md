# vault-semantic

L2 семантического слоя RAG-архитектуры волта (см. `docs/RAG_Architecture.md`).
Hybrid search (bge-m3 dense + BM25 с лемматизацией) поверх SQLite + sqlite-vec,
RRF-fusion. Шипает MCP-сервер (4 tools) + skill `/vault-rag` (L3-роутер).

## Зависимости

- Python ≥ 3.11 в `PATH` (детектится `ops/install.mjs`).
- Опционально NVIDIA GPU + nvidia-smi — для CUDA torch (~5x reindex speedup).
- Модуль `core` (managed-block в `CLAUDE.md`).
- Модуль `vault-index` (L1 — RAG §8.6).
- Harness (`harness-claude-code`) для регистрации MCP-сервера.

## Layout (install_scope: shared)

Heavy-артефакты живут в `$VAULT_TOOLS_HOME/vault-semantic/` — один на машину,
независимо от количества волтов. См. `docs/Shared_Install_Architecture.md`.

```
$VAULT_TOOLS_HOME/vault-semantic/
  .installed         # marker {version, source_sha, python_version, torch_variant}
  .venv/             # CPU ~1.2 GB / CUDA ~3.5 GB
  mcp/               # source-копия + editable install
  data/hf-cache/     # bge-m3 ~2 GB
  shim/index.mjs     # Phase 4.7 Node stdio-shim → Python HTTP

<vault>/.claude/modules/vault-semantic/
  .installed         # marker {version, linked_to, torch_variant}
  data/vault.sqlite  # ~150 KB / 100 заметок
```

## torch variant: CPU vs CUDA (v0.4.0+)

`config.vault-semantic.device` в манифесте — `auto` (default) / `cpu` / `cuda`.

`auto` + nvidia-smi обнаружил NVIDIA GPU + первый install → install handler
останавливается со `status: needs_torch_decision`, skill спрашивает юзера.
Выбор записывается в манифест и больше не пересматривается.

### Дисковая стоимость и выигрыш

Замер на RTX 3070 Laptop / driver 591.74 / Python 3.14 / cp314+cu126:

| | torch wheel | shared venv total | bge-m3 cache | per-vault | сек/note reindex |
|---|---|---|---|---|---|
| CPU | ~200 MB | ~1.2 GB | ~2 GB | ~150 KB / 100 notes | ~23 сек |
| CUDA (cu126) | ~2.6 GB | ~3.5 GB | ~2 GB | ~150 KB / 100 notes | ~4.5 сек |
| Δ CUDA | +2.4 GB | +2.3 GB | — | — | -18 сек/note |

**Итого на машину (shared + один типичный волт):**

| вариант | shared install | per-vault (100 notes) | первичный reindex |
|---|---|---|---|
| CPU | ~3.2 GB | ~150 KB | ~40 мин |
| CUDA | ~5.5 GB | ~150 KB | ~8 мин |

**Прогноз reindex по размеру волта** (extrapolation, на RTX 3070 Laptop):

| Notes | CPU (мин) | CUDA (мин) | speedup |
|---|---|---|---|
| 25 | ~10 | ~2 | 5x |
| 50 | ~20 | ~4 | 5x |
| 100 | ~40 | ~8 | 5x |
| 250 | ~100 | ~19 | 5.3x |
| 500 | ~200 | ~38 | 5.3x |
| 1000 | ~400 | ~75 | 5.3x |

**Caveats:**
- Speedup растёт с GPU-классом (4090 быстрее на embedding step), но упирается
  в CPU-bound chunking / pymorphy3 / sqlite/FTS5 → выше ~7x не разогнать без
  параллелизации этих шагов.
- Tiny vaults (<20 notes) — warmup (~15-25 сек bge-m3 load) съест выигрыш.
- Incremental refresh (mtime-snapshot + 2s debounce, v0.2.0) одинаково быстр
  в любом варианте — full reindex платится только при первом install и при
  смене chunker/schema/model.

### Когда выбирать CPU

- Нет NVIDIA GPU (AMD/Intel/Apple Silicon — пока не поддержано, ROCm/MPS планируются).
- Драйвер < 525 (нужен для CUDA 12.6).
- Минимизация диска (laptop SSD < 256 GB, fewer big-wheels).
- Tiny vault (<25 notes) — overhead не окупится.

### Когда выбирать CUDA

- Есть RTX-class GPU + современный драйвер.
- Vault ≥50 notes ИЛИ ожидается рост.
- Регулярно делаешь полный reindex (например после смены model в config).

### Смена variant после install

Открой `.claude/vault-manifest.yaml`, поменяй `config.vault-semantic.device`,
запусти `/init-vault --module vault-semantic`. Install handler детектит drift
между manifest и `.installed{torch_variant}` → свопает torch (`pip install
--force-reinstall torch` с правильным `--index-url`). Время свопа на CUDA:
~7 мин (download 2.6 GB).

## Что делает install (v0.4.0)

1. Проверяет `mcp/pyproject.toml` в shared root.
2. Детектит Python ≥3.11.
3. Resolves torch variant:
   - `device: cpu|cuda` → прямо.
   - `device: auto`:
     - читает `.installed{torch_variant}` (prior choice) — если есть, использует.
     - probe nvidia-smi → нет GPU → silent CPU; есть GPU + первый install → emit `needs_torch_decision`, ждёт решения.
4. `pip install -e mcp/` с `--extra-index-url https://download.pytorch.org/whl/cu126` для CUDA или дефолтным PyPI для CPU.
5. Drift detection: если установленный torch не совпадает с target — force-reinstall с правильным index.
6. Smoke import `vault_semantic`.
7. Skills (`/vault-rag` в `.claude/skills/`).
8. Sub-block в `CLAUDE.md`.
9. Markers (shared + per-vault) с `torch_variant`.

## MCP tools

- `vault_semantic_search(query, mode, k, filter?)` — dense / bm25 / hybrid (RRF).
- `vault_semantic_reindex(scope: 'changed'|'full')` — обычно не нужен (lazy refresh в `search/stats`).
- `vault_semantic_stats()` — chunks count / version / device hint.
- `vault_semantic_warmup()` — eager bge-m3 load (first call slow).

См. `docs/RAG_Architecture.md` для деталей API, schema, ranking.
