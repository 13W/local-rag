<div align="center">
  <img src="logo.svg" width="80" height="80" alt="local-rag logo">
</div>

# local-rag — Distributed Memory + Code RAG for Claude Code & Gemini CLI

[![npm](https://img.shields.io/npm/v/@13w/local-rag)](https://www.npmjs.com/package/@13w/local-rag)
[![GitHub](https://img.shields.io/badge/github-13W%2Flocal--rag-blue)](https://github.com/13W/local-rag)

Semantic memory and code intelligence as an MCP server for Claude Code and Gemini CLI agents.
11 tools that give AI agents persistent memory, semantic code search, import graph traversal, and symbol-level navigation — all running locally.

## What it does

| Tool | Description |
|------|-------------|
| `recall(query)` | Semantic search across stored memories |
| `remember(content)` | Store memory with type / scope / tags / importance |
| `search_code(query)` | Hybrid RAG over indexed codebase (4 modes, reranker, name filter) |
| `find_usages(symbol_id)` | Find callers/references of a symbol (lexical + semantic, self-excluded) |
| `get_file_context(file_path)` | Read file + list indexed symbols with UUIDs for `find_usages` |
| `get_dependencies(file_path)` | Import graph traversal (forward / reverse / transitive) |
| `project_overview()` | 3-level directory tree, entry points, top imports |
| `forget(memory_id)` | Delete a memory permanently |
| `give_feedback(content)` | Record agent feedback / session observations |
| `consolidate(source, target)` | Merge similar memories to reduce redundancy |
| `stats()` | Memory and index statistics |

## Stack

- **Qdrant** — vector database (Rust, production-ready)
- **Ollama** — local embeddings (`embeddinggemma:300m`)
- **tree-sitter** — multi-language code parser (TypeScript, JavaScript, Go, Rust)
- **MCP** — Model Context Protocol (HTTP transport)

---

## Prerequisites

### 1. Ollama (local embeddings)

Install: <https://ollama.com/download>

```bash
# Linux
curl -fsSL https://ollama.com/install.sh | sh

# macOS — download the app from:
# https://ollama.com/download/mac

# Windows — download the installer from:
# https://ollama.com/download/windows
```

Pull the embedding model:

```bash
ollama pull embeddinggemma:300m
```

### 2. Qdrant (vector database)

**Option A — Docker Compose (recommended)**

A ready-to-use `docker-compose.yml` is included in this repo:

```bash
docker compose up -d
```

Exposes port `6333` (REST) and `6334` (gRPC). Data persists in a named volume `qdrant-data`.

**Option B — Docker run**

```bash
docker run -d --name qdrant \
  -p 6333:6333 -p 6334:6334 \
  -v qdrant-data:/qdrant/storage \
  qdrant/qdrant
```

**Option C — Qdrant Cloud**

<https://cloud.qdrant.io/> — configure the Qdrant URL per-project via the dashboard after setup.

### 3. Node.js 18+

<https://nodejs.org/>

---

## Installation

### Claude Code

1. Add the marketplace source:

```bash
claude plugin marketplace add https://github.com/13w/local-rag
```

2. Install the plugin:

```bash
claude plugin install local-rag
```

> The plugin registers hooks and the MCP server automatically — no project-level `init` needed.

### Gemini CLI

```bash
gemini extensions install https://github.com/13w/local-rag
```

### Run the server (once per machine)

The plugin connects to a local HTTP server that must be running:

```bash
# Using npx (no global install needed)
npx @13w/local-rag serve

# Or after global install
npm install -g @13w/local-rag
local-rag serve
```

The server starts on port `7531` and opens a live dashboard at `http://127.0.0.1:7531`.

---

## Setup

local-rag runs as a **persistent HTTP server** shared across all your projects.
Start it once; the plugin auto-registers each project on first session.

### Step 1 — Start the server

```bash
local-rag serve
```

Leave it running. Every project that has the plugin installed connects automatically
on the first `SessionStart` hook.

### Step 2 — Index your codebase (optional but recommended)

```bash
local-rag index .
```

Open the dashboard at `http://127.0.0.1:7531` to monitor progress
or configure `include-paths` for monorepos.

Once indexed, `search_code`, `get_file_context`, and `find_usages` are ready to use.

---

## Configuration

### Server config — `~/.config/local-rag/config.json`

Global config for the `local-rag serve` daemon. Created automatically on first run.

```json
{
  "qdrant": {
    "url": "http://localhost:6333",
    "api_key": "",
    "tls": false,
    "prefix": ""
  },
  "port": 7531
}
```

Project settings (embed model, include paths, etc.) are configured per-project via the dashboard.

---

## search_code — search modes and reranker

`search_code` supports four modes via the `search_mode` parameter:

| Mode | Description |
|------|-------------|
| `hybrid` (default) | 3-way RRF fusion: code vector + description vector + lexical text leg |
| `code` | Code vector only — exact structural similarity |
| `semantic` | Description vector only — conceptual search when you don't know the name |
| `lexical` | Text index filter — only chunks where query terms literally appear in name or content |

### Cross-encoder reranker

After vector retrieval, an optional cross-encoder pass (`Xenova/bge-reranker-base`) re-scores and reorders results for higher precision:

```
search_code("embedOne", rerank=true, rerank_k=50, top=5)
# Fetches 50 ANN candidates, scores all 50 with the cross-encoder, returns top 5
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `rerank` | `false` | Enable cross-encoder reranking |
| `rerank_k` | `50` | ANN candidates to fetch before reranking |
| `top` | `limit` | Results to return after reranking |

### Symbol name filter

```
search_code("embed vector", name_pattern="embed")
# Only returns chunks whose name contains "embed" (prefix-tokenized index)
```

### Symbol-aware workflow

Every symbol UUID surface (`search_code`, `get_file_context`) feeds directly into the two symbol tools:

```
# From search
search_code("parse imports typescript")
# → id:  abc-123-...  file: src/parser.ts  name: extractImports

# From file listing
get_file_context("src/parser.ts")
# → function  extractImports  (lines 248–264)  id: abc-123-...

# Find all callers / references
find_usages("abc-123-...", limit=20)
# Returns [lexical] hits (literal name match) + [semantic] hits (conceptual match), self-excluded
```

---

## Indexing Your Codebase

The recommended way is via the **live dashboard** at `http://127.0.0.1:7531` — start the indexer from there and configure `include-paths` for monorepos.

Alternatively, use the CLI:

```bash
# Index once
local-rag index .

# Watch mode — re-indexes on file changes
local-rag watch .
```

Other indexer commands:

```bash
local-rag clear               # remove all indexed chunks for this project
local-rag stats               # show collection statistics
local-rag file <abs> <root>   # index a single file
local-rag repair .            # fix empty symbol names (payload-only, no re-embedding)
local-rag gc .                # clean up chunks for deleted git branches
local-rag re-embed            # re-generate embeddings (e.g. after changing embed model)
```

`repair` is useful after updating to a version with improved parser extraction logic: it patches only the `name` field for affected chunks without regenerating embeddings or descriptions.

---

## Live Dashboard

`local-rag serve` opens a browser dashboard at `http://127.0.0.1:7531`.
It displays real-time tool call statistics (calls, bytes, latency, errors per tool),
a scrolling request log, a server info bar (project, branch, version, watch status),
and an interactive tool playground for testing calls manually.

The default port is `7531`. To use a different port or disable the dashboard:

```json
{ "port": 8080 }
{ "dashboard": false }
```

---

## Memory Types

| Type | Use for | Decay |
|------|---------|-------|
| `episodic` | Events, bugs, incidents | Time-decayed |
| `semantic` | Facts, architecture, decisions | Long-lived |
| `procedural` | Patterns, conventions, how-to | Long-lived |

---

## Agent Protocol

After plugin installation, the following hooks fire automatically on each agent session:

| Hook | Trigger | Action |
|------|---------|--------|
| `SessionStart` | Agent starts | Injects memory snapshot into system context |
| `UserPromptSubmit` / `BeforeAgent` | User sends prompt | Runs semantic recall against the prompt |
| `Stop` / `AfterAgent` | Agent finishes | Stores new memories from the session |
| `SessionEnd` | Session ends | Records session feedback |

The full `RECALL → SEARCH_CODE → THINK → ACT → REMEMBER` protocol is delivered via MCP server instructions on handshake — no files are written into `.claude/rules/`.
