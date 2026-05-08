# Installation

Step-by-step setup for `local-rag` as a Claude Code plugin and/or a Gemini CLI extension.

The README has a quickstart. This doc is the verbose version with prerequisites, both runtimes, server setup, and migration from older layouts.

## Prerequisites

You need three things running before installing the plugin:

### 1. Node.js 18+

<https://nodejs.org/>

### 2. Ollama (local embeddings)

```bash
# Linux
curl -fsSL https://ollama.com/install.sh | sh
# macOS / Windows: download from https://ollama.com/download
```

Pull the embedding model:

```bash
ollama pull embeddinggemma:300m
```

Ollama's daemon must be running on the default port (`11434`). It usually auto-starts; on Linux you may need `systemctl --user start ollama` or `ollama serve &`.

### 3. Qdrant (vector database)

The repo ships a `docker-compose.yml`:

```bash
docker compose up -d
```

This exposes `6333` (REST) and `6334` (gRPC) and persists data in the `qdrant-data` Docker volume.

Alternatives: bare `docker run` or Qdrant Cloud — see `README.md → Prerequisites → 2. Qdrant`.

## Install the server

The server is published as `@13w/local-rag` on npm. Pick one form:

```bash
# Option A: no global install
npx @13w/local-rag serve

# Option B: globally installed CLI
npm install -g @13w/local-rag
local-rag serve
```

The server starts on port `7531` and opens a live dashboard at <http://127.0.0.1:7531>. Leave it running (background, tmux, systemd unit — your choice). The plugins won't function without it.

Override the port via `~/.config/local-rag/config.json`:

```json
{ "port": 7531 }
```

## Install the Claude Code plugin

```bash
# 1. Add the marketplace
claude plugin marketplace add https://github.com/13w/local-rag

# 2. Install the plugin from that marketplace
claude plugin install local-rag@local-rag
```

What this wires up:

- `extensions/claude/hooks/hooks.json` — registers `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`.
- `extensions/claude/.mcp.json` — registers the `memory` MCP server (stdio via `mcp-proxy.mjs`, which proxies to the running HTTP server).

Verify in a fresh Claude Code session:

```
/plugin
  → local-rag should appear under Installed
```

The first prompt in any project triggers `SessionStart` → auto-registers the project (POST `/api/projects` to the server). After that, `recall` runs on every prompt and `remember` runs on every `Stop`. No project-level config required.

## Install the Gemini CLI extension

The Gemini extension lives in a subdirectory of the repo, so install it from a local checkout:

```bash
git clone https://github.com/13w/local-rag
gemini extensions install ./local-rag/extensions/gemini
```

What this wires up:

- `extensions/gemini/hooks/hooks.json` — registers `SessionStart`, `BeforeAgent`, `AfterAgent`, `SessionEnd`.
- `extensions/gemini/gemini-extension.json` — declares the `local-rag` MCP server (stdio via `mcp-proxy.mjs`) and injects `CLAUDE_PROJECT_DIR=${workspacePath}` into the MCP env.

Reload Gemini CLI after install. Same protocol as Claude — `BeforeAgent` ≈ `UserPromptSubmit`, `AfterAgent` ≈ `Stop`.

> **Hooks env caveat.** Gemini does not always propagate MCP `env` blocks into hook subprocesses. If hooks run with the wrong `cwd`, edit `extensions/gemini/hooks/hooks.json` and add `"env": { "CLAUDE_PROJECT_DIR": "${workspacePath}" }` to each hook entry.

## First-time index (recommended)

The plugin works with an empty index — `recall` will just return nothing until memories accumulate. To unlock `search_code`, `find_usages`, `get_dependencies`, `project_overview`, run the indexer once per project:

```bash
cd /path/to/your/project
local-rag index
```

The indexer is incremental and watch-aware — `serve` auto-watches projects that were registered via `SessionStart`, so a manual `index` is only needed for the first cold start or after large rebases.

## Verify end-to-end

With the server running and the plugin/extension installed, in any Claude Code or Gemini CLI session:

```
> recall("anything")
```

Expected: an MCP tool result (possibly empty `results: []` if nothing is indexed yet). Server logs show an inbound `/mcp` request.

If the call errors with `Failed to connect`, check (in this order):

1. Is the server running? `curl -s http://127.0.0.1:7531/api/projects | head`
2. Is the MCP path correct? In `extensions/claude/.mcp.json` the `args` should end in `hooks/shared/mcp-proxy.mjs`.
3. Is the `hooks/shared` symlink intact? `readlink extensions/claude/hooks/shared` → `../../../shared/hooks`.
4. Did the plugin re-install pick up your latest commit? `claude plugin uninstall local-rag@local-rag && claude plugin install local-rag@local-rag`.

## Migration from earlier layouts

Older versions of this repo kept the plugin/extension at the repo root with a single shared `hooks/hooks.json`. The current layout splits per-runtime under `extensions/` and shares the hook scripts via `shared/hooks/`. If you installed before the split:

```bash
# Claude Code
claude plugin uninstall local-rag@local-rag
claude plugin marketplace remove local-rag
claude plugin marketplace add https://github.com/13w/local-rag
claude plugin install local-rag@local-rag

# Gemini CLI
gemini extensions uninstall local-rag
git -C /path/to/local-rag pull
gemini extensions install /path/to/local-rag/extensions/gemini
```

No data migration is needed — Qdrant collections are unaffected by plugin layout changes.

## Uninstall

```bash
claude plugin uninstall local-rag@local-rag
gemini extensions uninstall local-rag
docker compose down                    # stop Qdrant
# (optional) remove vectors:
docker volume rm qdrant-data
# (optional) remove server config:
rm -rf ~/.config/local-rag
```
