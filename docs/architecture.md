# Architecture

`local-rag` is two things in one repo:

1. **A standalone HTTP server** — runs once per machine, owns Qdrant + Ollama, exposes MCP and hook endpoints.
2. **Two plugin/extension manifests** — thin clients that wire the server into Claude Code and Gemini CLI via hooks and MCP.

The plugins do not embed the server. They forward to it.

## Repo layout

```
.
├── .claude-plugin/marketplace.json   # Claude Code marketplace pointer
├── extensions/
│   ├── claude/                       # Claude Code plugin (CLAUDE_PLUGIN_ROOT)
│   │   ├── .claude-plugin/plugin.json
│   │   ├── .mcp.json                 # stdio MCP via shared/hooks/mcp-proxy.mjs
│   │   └── hooks/
│   │       ├── hooks.json            # SessionStart / UserPromptSubmit / Stop / SessionEnd
│   │       └── shared -> ../../../shared/hooks   # symlink
│   └── gemini/                       # Gemini CLI extension (extensionPath)
│       ├── gemini-extension.json     # mcpServers + Gemini settings
│       └── hooks/
│           ├── hooks.json            # SessionStart / BeforeAgent / AfterAgent / SessionEnd
│           └── shared -> ../../../shared/hooks   # symlink
├── shared/hooks/                     # single source of truth for hook scripts
│   ├── recall.mjs                    # POST {body} -> ${MEMORY_SERVER_URL}/hooks/recall
│   ├── remember.mjs                  # POST {body} -> /hooks/remember
│   ├── session-start.mjs             # POST /api/projects (auto-register)
│   ├── session-end.mjs               # POST /hooks/session-end
│   └── mcp-proxy.mjs                 # stdio <-> HTTP bridge to /mcp
├── src/                              # the local-rag npm package (server + CLI)
└── README.md
```

`extensions/<runtime>/hooks/shared` is a relative symlink to `shared/hooks/`. Both `${CLAUDE_PLUGIN_ROOT}/hooks/shared/*.mjs` and `${extensionPath}/hooks/shared/*.mjs` resolve to the same scripts. Symlink target stays inside the plugin/extension boundary, so marketplace-style copies keep working.

## Why two `hooks.json` files

Claude Code and Gemini CLI publish disjoint hook event vocabularies:

| Event purpose       | Claude Code        | Gemini CLI     |
|---------------------|--------------------|----------------|
| Session begins      | `SessionStart`     | `SessionStart` |
| User submits prompt | `UserPromptSubmit` | `BeforeAgent`  |
| Agent finishes turn | `Stop`             | `AfterAgent`   |
| Session ends        | `SessionEnd`       | `SessionEnd`   |

A single `hooks.json` cannot satisfy both — each runtime's loader rejects unknown keys. The split into per-runtime files is the only stable shape.

## Server (`src/`)

| File / dir              | Role                                                                        |
|-------------------------|------------------------------------------------------------------------------|
| `bin.ts`                | CLI entry — `serve`, `migrate`, `re-embed`, `index`, hook subcommands       |
| `http-server.ts`        | Fastify bootstrap; registers `mcp`, `hooks`, `dashboard` route plugins      |
| `plugins/mcp.ts`        | `/mcp` endpoint — Streamable-HTTP MCP transport, exposes the 11 tools       |
| `plugins/hooks.ts`      | `/hooks/recall`, `/hooks/remember`, `/hooks/session-end`                    |
| `plugins/dashboard.ts`  | `/`, `/api/*` — live UI + project registry                                  |
| `tools/`                | One file per MCP tool (recall, remember, search_code, find_usages, …)       |
| `indexer/`              | tree-sitter parsers, watcher, worker pool — populates Qdrant collections    |
| `embedder.ts`           | Ollama client (`embeddinggemma:300m` by default)                            |
| `qdrant.ts`             | Qdrant client wrapper                                                       |
| `archivist.ts`          | Memory consolidation / cleanup pipeline                                     |
| `session-store.ts`      | Per-session metadata (which agent / project / cwd)                          |
| `request-context.ts`    | Resolves `project_dir → project_id` per request                             |
| `scoring.ts`, `reranker.ts` | Hybrid scoring + cross-encoder rerank for `search_code`                  |

The server is a single Node process. State lives in Qdrant (vectors + payloads) and `~/.config/local-rag/config.json` (port, model overrides).

## Data stores

- **Qdrant** (port 6333 by default) — collections per project for memories and code chunks. The server creates / migrates collections at startup.
- **Ollama** (port 11434) — embeddings only. Called from `embedder.ts`. No model state in the server itself.
- **Local config** — `~/.config/local-rag/config.json`. Read by both the server and the hook scripts (so they agree on which port to talk to).

## Data flow

### `recall` from a Claude Code session

```
Claude Code session
  └─ UserPromptSubmit hook fires
       └─ extensions/claude/hooks/hooks.json runs:
            node ${CLAUDE_PLUGIN_ROOT}/hooks/shared/recall.mjs
              └─ symlink resolves to shared/hooks/recall.mjs
                   └─ POST  http://127.0.0.1:7531/hooks/recall
                        ?project_dir=${CLAUDE_PROJECT_DIR}
                        body = the prompt + transcript context
                          └─ http-server.ts → plugins/hooks.ts
                               └─ embed query (Ollama)
                               └─ search Qdrant (memories + code)
                               └─ score + rerank
                               └─ returns additionalContext JSON
                        ← response written to stdout
              ← Claude Code injects into the context window
```

### `remember` is the same path with `/hooks/remember` and `Stop` (Claude) / `AfterAgent` (Gemini).

### MCP tool calls

Claude Code: stdio MCP via `extensions/claude/.mcp.json` → spawns `node shared/hooks/mcp-proxy.mjs` → proxies stdio frames to `http://127.0.0.1:7531/mcp`.

Gemini CLI: same path through `extensions/gemini/gemini-extension.json:mcpServers.local-rag`.

### Indexing

`local-rag index` (or the watcher started by `serve`) walks the project tree, runs tree-sitter parsers (`indexer/parser.ts`), produces symbol records and code chunks, embeds them via Ollama, and upserts into Qdrant. The watcher keeps the index in sync as files change.

## Boundary rules

- **No state inside the plugin.** The plugin manifests, hook scripts, and MCP proxy hold no data — they translate runtime events into HTTP calls. Restarting the editor does not lose memory; restarting the server with Qdrant intact does not lose memory.
- **`CLAUDE_PROJECT_DIR` is the project key.** Hooks pass it as `?project_dir=…`; the server resolves it to a `project_id` (auto-creating one on first sight). Same value works in both runtimes — Gemini's `gemini-extension.json` injects `CLAUDE_PROJECT_DIR=${workspacePath}` into the MCP env.
- **Hook scripts are runtime-agnostic.** They read `process.env.CLAUDE_PROJECT_DIR ?? process.cwd()`. The Gemini-side per-hook env may need to be set explicitly if the runtime does not propagate the MCP env to hook subprocesses.
- **`shared/hooks/` is the only place the scripts live.** Do not duplicate. Editing the scripts under `extensions/<runtime>/hooks/shared/` edits the source through the symlink.

## Adding a new MCP tool

1. New file under `src/tools/<name>.ts`.
2. Register it in `src/tools/registry.ts`.
3. Add a unit test next to it (`<name>.test.ts`).
4. Update the README tool table and the matching tool list inside the MCP `tools/list` response.

No plugin manifest changes are needed — both runtimes pick up the new tool automatically through the MCP `tools/list` round-trip.
