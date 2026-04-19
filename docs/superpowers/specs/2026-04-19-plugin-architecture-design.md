# Plugin Architecture Design — local-rag v3

**Date:** 2026-04-19
**Replaces:** README update spec (`2026-04-19-readme-update-design.md`) — README update is paused until plugin is shipped.

---

## Goal

Replace the manual `local-rag init` setup flow with a proper Claude Code plugin + Gemini extension. After this change, the user runs two commands once per machine and every project auto-configures itself.

**New user flow:**
```
1. local-rag serve                         (once per machine — stays running)
2. claude plugin install @13w/local-rag    (once per user)
→ Done. Every project auto-registers on first SessionStart.
```

---

## Plugin structure

```
(local-rag repo root)
├── .claude-plugin/
│   └── plugin.json          — name, description, author
├── .mcp.json                — declares MCP server with ${CLAUDE_PROJECT_DIR}
├── hooks/
│   ├── hooks.json           — declares SessionStart, UserPromptSubmit, Stop, SessionEnd
│   ├── session-start.mjs    — auto-registers project via POST /api/projects
│   ├── recall.mjs           — calls local-rag hook-recall --project-dir $CLAUDE_PROJECT_DIR
│   ├── remember.mjs         — calls local-rag hook-remember --project-dir $CLAUDE_PROJECT_DIR
│   └── session-end.mjs      — calls local-rag hook-session-end --project-dir $CLAUDE_PROJECT_DIR
├── CLAUDE.md                — memory protocol instructions (moved from MCP server instructions)
├── GEMINI.md                — same for Gemini
└── gemini-extension.json    — Gemini extension manifest
```

---

## .mcp.json (plugin root)

```json
{
  "mcpServers": {
    "memory": {
      "type": "http",
      "url": "http://localhost:7531/mcp?project_dir=${CLAUDE_PROJECT_DIR}"
    }
  }
}
```

`${CLAUDE_PROJECT_DIR}` is a Claude Code plugin variable — confirmed available in plugin `.mcp.json` files (used in official plugin dev examples for `@modelcontextprotocol/server-filesystem`).

No project-local files are touched. No `settings.json` / `.mcp.json` in the user's project is modified.

---

## hooks/hooks.json

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs\"" }] }
    ],
    "UserPromptSubmit": [
      { "matcher": ".*", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs\"" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/remember.mjs\"" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/session-end.mjs\"" }] }
    ]
  }
}
```

Hook scripts read `CLAUDE_PROJECT_DIR` from the environment and pass `--project-dir` to the local-rag CLI.

---

## Server-side changes

### 1. Naming: `project_root` → `project_dir` everywhere

Rename `project_root` to `project_dir` in:
- `ProjectConfig` interface (`src/server-config.ts`)
- All Qdrant payloads that store this field
- `POST /api/projects` request body
- `GET /api/projects` response
- `IndexerManager` references
- Hook CLI args (`--project-root` → `--project-dir`)
- Any other reference in the codebase

### 2. MCP endpoint: resolve `project_dir` → `project_id`

`/mcp?project_dir=/abs/path` replaces `/mcp?project=X&agent=Y`.

Resolution logic:
1. Look up registered project with matching `project_dir`
2. If found → use its `project_id`
3. If not found → auto-create project: `project_id = basename(project_dir)`, `project_dir = the path`

### 3. Remove `agent` concept

Strip `agent_id` from:
- `ProjectConfig` interface
- All Qdrant payloads
- Hook CLI args (`--agent` flag removed)
- MCP URL params
- `src/request-context.ts` — remove `getAgentId()`
- `src/init.ts` — remove agent prompt and all agent references
- `src/session-store.ts` — key on project only
- Dashboard — remove agent column/filter
- All other references

`project_id` remains as the sole namespace identifier.

---

## gemini-extension.json

```json
{
  "name": "local-rag",
  "description": "Persistent semantic memory and code RAG for Gemini CLI",
  "version": "...",
  "contextFileName": "GEMINI.md"
}
```

Gemini installation: `gemini extensions install https://github.com/13w/local-rag`

---

## CLAUDE.md / GEMINI.md (plugin root)

Move the memory protocol instructions currently delivered via MCP `server instructions` into `CLAUDE.md` in the plugin root. This gives them higher salience (loaded at session start, not just on MCP handshake) and makes them available even before the MCP server connects.

Keep MCP `instructions` as a shorter fallback summary for non-plugin users.

---

## What happens to `local-rag init`

`init` is deprecated but not removed immediately. It prints a deprecation notice pointing to `claude plugin install @13w/local-rag`. The v1→v2 migration guide in the README documents the cleanup steps (old hooks, rules, CLAUDE.md blocks — see paused README spec).

---

## Out of scope

- Changing the indexer CLI (`index`, `watch`, `re-embed`, `repair`, etc.) — no changes
- Dashboard UI — only agent column removal
- The server HTTP port or Qdrant bootstrap flow — no changes
- Publishing to a plugin marketplace — separate task after the plugin is working locally

---

## Open questions

- Does `${CLAUDE_PROJECT_DIR}` get URL-encoded by Claude Code? The server must handle both encoded and raw paths.
- Does the plugin hook receive `CLAUDE_PROJECT_DIR` as an env var at hook execution time? Needs verification during implementation.
