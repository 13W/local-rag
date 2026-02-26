<div align="center">
  <img src="logo.svg" width="80" height="80" alt="local-rag logo">
</div>

# local-rag — Distributed Memory + Code RAG for Claude Code

[![npm](https://img.shields.io/npm/v/@13w/local-rag)](https://www.npmjs.com/package/@13w/local-rag)
[![GitHub](https://img.shields.io/badge/github-13W%2Flocal--rag-blue)](https://github.com/13W/local-rag)

Semantic memory and code intelligence as an MCP plugin for Claude Code agents.
9 tools that give Claude persistent memory, semantic code search, and import graph traversal — all running locally.

## What it does

| Tool | Description |
|------|-------------|
| `recall(query)` | Semantic search across stored memories |
| `remember(content)` | Store memory with type / scope / tags / importance |
| `search_code(query)` | Hybrid RAG over indexed codebase |
| `get_file_context(file_path)` | Read file + list indexed symbols |
| `get_dependencies(file_path)` | Import graph traversal (forward / reverse / transitive) |
| `project_overview()` | 3-level directory tree, entry points, top imports |
| `forget(memory_id)` | Delete a memory permanently |
| `consolidate()` | Merge semantically similar memories |
| `stats()` | Memory and index statistics |

## Stack

- **Qdrant** — vector database (Rust, production-ready)
- **Ollama** — local embeddings (`mxbai-embed-large`)
- **tree-sitter** — multi-language code parser (TypeScript, JavaScript, Go, Rust)
- **MCP** — Model Context Protocol (stdio transport)

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
ollama pull mxbai-embed-large
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

## Claude Code Plugin Setup

### Install local-rag

**Option A — `claude mcp add` with npx (no global install needed)**

Per-project (stored in `.mcp.json`, shared with the team):

```bash
claude mcp add memory -- npx -y @13w/local-rag serve --config .memory.json
```

Global — available in all projects on this machine:

```bash
claude mcp add memory -s user -- npx -y @13w/local-rag serve --config .memory.json
```

**Option B — `.mcp.json` directly**

```json
{
  "mcpServers": {
    "memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@13w/local-rag", "serve", "--config", ".memory.json"]
    }
  }
}
```

**Option C — After global `npm install -g`**

```bash
claude mcp add memory -- local-rag serve --config .memory.json
```

---

### Install Serena (recommended companion)

Serena provides filesystem access and precise symbolic code editing that complements local-rag:
local-rag finds code by meaning, Serena reads and edits it surgically.

Repo: <https://github.com/oraios/serena>

**Requirements:** Python 3.10+, [`uv`](https://docs.astral.sh/uv/)

```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# Register Serena as a Claude Code plugin (per-project)
claude mcp add serena -- uvx --from serena serena-mcp-server --context ide-assistant --project .
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "serena": {
      "type": "stdio",
      "command": "uvx",
      "args": ["--from", "serena", "serena-mcp-server", "--context", "ide-assistant", "--project", "."]
    }
  }
}
```

---

### Combined `.mcp.json` (both plugins)

```json
{
  "mcpServers": {
    "memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@13w/local-rag", "serve", "--config", ".memory.json"]
    },
    "serena": {
      "type": "stdio",
      "command": "uvx",
      "args": ["--from", "serena", "serena-mcp-server", "--context", "ide-assistant", "--project", "."]
    }
  }
}
```

---

## Configuration

Create `.memory.json` in your project root (auto-discovered if present):

```json
{
  "project-id": "my-project",
  "project-root": ".",
  "qdrant-url": "http://localhost:6333",
  "embed-provider": "ollama",
  "embed-model": "mxbai-embed-large",
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

> ¹ `embed-model` defaults: `ollama` → `mxbai-embed-large`, `openai` → `text-embedding-3-small`, `voyage` → `voyage-code-3`
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

## Indexing Your Codebase

Before `search_code` and `get_file_context` tools return results, index the project:

```bash
# Index once
npx @13w/local-rag index . --config .memory.json

# Watch mode — re-indexes on file changes
npx @13w/local-rag watch . --config .memory.json

# If installed globally
local-rag index . --config .memory.json
local-rag watch . --config .memory.json
```

Other indexer commands:

```bash
local-rag clear --config .memory.json    # remove all indexed chunks
local-rag stats --config .memory.json    # show collection statistics
local-rag file <abs-path> <root>         # index a single file
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

Copy `CLAUDE.md` into your project to give Claude Code the full `RECALL → SEARCH_CODE → THINK → ACT → REMEMBER` protocol, including how local-rag and Serena complement each other.
