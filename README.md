# 🧠 Claude Memory System

Distributed semantic memory + Code RAG for Claude Code agents.

## Stack
- **Qdrant** — vector database (Rust, fast, production-ready)
- **Ollama** — local embedding model (mxbai-embed-large)
- **MCP** — Model Context Protocol (stdio transport to Claude Code)
- **tree-sitter** — TypeScript/JavaScript code parser

## Quick Start

```bash
chmod +x setup.sh
./setup.sh
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `recall(query)` | Semantic search across memory |
| `remember(content)` | Store a new memory |
| `search_code(query)` | RAG search over codebase |
| `forget(id)` | Delete a memory |
| `consolidate()` | Merge similar memories |
| `stats()` | Memory statistics |

## Memory Types

- **episodic** — events, bugs, incidents (has time decay)
- **semantic** — facts, architecture, decisions (long-lived)
- **procedural** — patterns, conventions, how-to (long-lived)
