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

<https://cloud.qdrant.io/> — set `qdrant-url` in `.memory.json` to your cluster endpoint.

### 3. Node.js 18+

<https://nodejs.org/>

---

## Installation

**From npm (recommended):**

```bash
npm install -g @13w/local-rag
```

**From source:**

```bash
git clone https://github.com/13W/local-rag.git
cd local-rag
npm install && npm run build
```

---

## Setup

local-rag runs as a **persistent HTTP server** shared across all your projects.
You start it once, then register each project with `init`.

### Step 1 — Start the server

```bash
# Using npx (no global install needed)
npx @13w/local-rag serve

# Or after global install
local-rag serve
```

The server starts on port `7531` by default and opens the live dashboard in your browser.
MCP endpoint: `http://127.0.0.1:7531/mcp?project=<id>&agent=<id>`

> The server must be running before using any agent tools or running `init`.

### Step 2 — Register a project

Run once in each project root:

```bash
npx @13w/local-rag init

# Or after global install
local-rag init
```

Interactive prompts:
```
Project name [my-project]:
Agent name [my-project]:
```

`init` automatically:
- Registers the project on the running server
- Writes MCP wiring and hooks to `.claude/settings.local.json` (Claude Code)
- Writes MCP wiring and hooks to `.gemini/settings.json` if `.gemini/` exists (Gemini CLI)
- Prints the dashboard URL for this project

Output:
```
[init] Configured settings.local.json (Claude Code)
[init] Configured .gemini/settings.json (Gemini CLI)
[init] Project 'my-project' created.
[init] Dashboard: http://127.0.0.1:7531/?project=my-project
```

> Do not commit `.claude/settings.local.json` — it contains machine-local paths.
> Commit `.claude/settings.json` only if it exists and was set up separately for team sharing.

### Step 3 — Index your codebase

Open the dashboard and start the indexer there, **or** use the CLI:

```bash
local-rag index .
```

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

### Indexer CLI config — `.memory.json`

Optional config file for standalone CLI commands (`index`, `watch`, `clear`, etc.).
Not used by `local-rag serve`.

```json
{
  "project-id": "my-project",
  "project-root": ".",
  "qdrant-url": "http://localhost:6333",
  "embed-provider": "ollama",
  "embed-model": "embeddinggemma:300m",
  "ollama-url": "http://localhost:11434"
}
```

### Full config reference

| Key | Default | Description |
|-----|---------|-------------|
| `project-id` | `"default"` | Isolates memories and code index per project |
| `project-root` | config file directory | Root path for code indexing |
| `qdrant-url` | `http://localhost:6333` | Qdrant REST API URL |
| `embed-provider` | `"ollama"` | Embedding provider: `ollama`, `openai`, `voyage` |
| `embed-model` | provider default¹ | Embedding model name |
| `embed-dim` | `1024` | Embedding vector dimension |
| `embed-api-key` | `""` | API key for OpenAI / Voyage embed providers — falls back to `OPENAI_API_KEY` / `VOYAGE_API_KEY` env var |
| `embed-url` | `""` | Custom embedding API endpoint |
| `ollama-url` | `http://localhost:11434` | Ollama API URL |
| `agent-id` | `"default"` | Agent identifier (for multi-agent setups) |
| `llm-provider` | `"ollama"` | LLM provider: `ollama`, `anthropic`, `openai` |
| `llm-model` | provider default² | LLM model for reranking / description generation |
| `llm-api-key` | `""` | API key for Anthropic / OpenAI LLM providers — falls back to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env var |
| `llm-url` | `""` | Custom LLM API endpoint |
| `include-paths` | `[]` | Glob patterns to limit indexing scope (monorepos) |
| `generate-descriptions` | `false` | Auto-generate LLM descriptions for code chunks (slow) |
| `dashboard` | `true` | Enable the live dashboard HTTP server |
| `dashboard-port` | `0` | Dashboard HTTP port; `0` lets the OS pick a random port |
| `collection-prefix` | `""` | String prepended to all Qdrant collection names (useful on shared Qdrant instances) |
| `no-watch` | `false` | Disable automatic file re-indexing when files change (applies during `serve`) |

> ¹ `embed-model` defaults: `ollama` → `embeddinggemma:300m`, `openai` → `text-embedding-3-small`, `voyage` → `voyage-code-3`
>
> ² `llm-model` defaults: `ollama` → `gemma3n:e2b`, `anthropic` → `claude-haiku-4-5-20251001`, `openai` → `gpt-4o-mini`
>
> **Resolution order (highest to lowest priority):** CLI flag → `.memory.json` value → environment variable → built-in default.
>
> API key environment variables are provider-specific:
> | Provider | `embed-api-key` env var | `llm-api-key` env var |
> |----------|------------------------|-----------------------|
> | `openai` | `OPENAI_API_KEY` | `OPENAI_API_KEY` |
> | `voyage` | `VOYAGE_API_KEY` | — |
> | `anthropic` | — | `ANTHROPIC_API_KEY` |
>
> All other keys can also be passed as CLI flags (e.g. `--project-id foo`).
> CLI flags override config file values. `include-paths` is config-file only.

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

The recommended way is via the **live dashboard** — open it after `local-rag init` and start the indexer from there. It shows progress and lets you configure `include-paths` for monorepos.

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

After `local-rag init`, the following hooks fire automatically on each agent session:

| Hook | Trigger | Action |
|------|---------|--------|
| `SessionStart` | Agent starts | Injects memory snapshot into system context |
| `UserPromptSubmit` / `BeforeAgent` | User sends prompt | Runs semantic recall against the prompt |
| `Stop` / `AfterAgent` | Agent finishes | Stores new memories from the session |
| `SessionEnd` | Session ends | Records session feedback |

The full `RECALL → SEARCH_CODE → THINK → ACT → REMEMBER` protocol is delivered via MCP server instructions on handshake — no files are written into `.claude/rules/`.
