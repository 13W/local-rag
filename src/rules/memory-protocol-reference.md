# Memory MCP — Detailed Reference

## Tools Available

9 tools: `recall`, `remember`, `search_code`, `get_file_context`, `get_dependencies`, `project_overview`, `forget`, `consolidate`, `stats`.

All agents share project-scope memory.

---

## search_code — Semantic RAG over codebase

### Search modes

| Mode | Description | When to use |
|------|-------------|-------------|
| `hybrid` (default) | RRF fusion of code + description vectors | Best for most queries |
| `code` | Code vector only | Exact structural matches |
| `semantic` | Description vector only | Conceptual search when you don't know the name |

### Parameters

- `query` (required) — natural language description of what you're looking for
- `chunk_type` — filter by symbol type: `"function"`, `"class"`, `"interface"`, `"type_alias"`, `"enum"`
- `file_path` — filter by file path substring: `"src/auth"`
- `search_mode` — `"hybrid"` (default), `"code"`, `"semantic"`
- `limit` — max results 1-20 (default 10)

### Examples

```
search_code(query="router middleware auth")
search_code(query="config validation", chunk_type="function")
search_code(query="user permissions check", file_path="src/core", search_mode="semantic")
```

---

## get_file_context — Read file or symbol

```
get_file_context(file_path="src/auth/jwt.ts")                                    # whole file
get_file_context(file_path="src/auth/jwt.ts", symbol_name="verifyToken")         # single symbol
get_file_context(file_path="src/auth/jwt.ts", start_line=40, end_line=80)        # line range
```

Returns file content + list of all indexed symbols with line ranges.

---

## get_dependencies — Impact analysis

```
get_dependencies(file_path="src/auth/jwt.ts")                           # imports + imported_by
get_dependencies(file_path="src/auth/jwt.ts", direction="imported_by")  # who depends on this
get_dependencies(file_path="src/auth/jwt.ts", direction="imports")      # what this imports
get_dependencies(file_path="src/auth/jwt.ts", depth=3)                  # transitive deps
```

Always check `imported_by` before modifying a file to understand blast radius.

---

## project_overview — Codebase orientation

```
project_overview()
```

Returns: directory tree (3 levels), entry points, language stats, indexed file count, top-10 most-imported modules.

Use when: entering an unfamiliar codebase, starting a new task in a different area.

---

## Memory Types

| Type | Description | Time decay | Use for |
|------|-------------|------------|---------|
| `episodic` | Events, bugs, what happened | Yes | Bug fixes, incidents, debugging sessions |
| `semantic` | Facts, knowledge, architecture | No (long-lived) | Decisions, business logic, architecture |
| `procedural` | Patterns, conventions | No (long-lived) | "How to do X", coding patterns, workflows |

## Scope

| Scope | Visibility |
|-------|------------|
| `project` | All agents on this project (default) |
| `agent` | Private to this agent session |
| `global` | Across all projects |

---

## Tagging Conventions

Use consistent, composable tags:

**By area:** `auth`, `api`, `db`, `frontend`, `backend`, `infra`, `ci`
**By type:** `bug`, `decision`, `pattern`, `refactoring`, `security`
**By framework:** `router`, `middleware`, `config`, `schema`, `plugin`

Example: `tags="auth,bug,redis"` or `tags="api,decision,versioning"`

---

## remember() Best Practices

**Size limit:** embedder truncates at 2000 characters. Anything longer is lost during search.

**One entry = one fact / one solution / one bug.** Split large findings.

**Bad:**
```
remember(content="Refactored auth: rewrote JWT, added refresh tokens, fixed race condition, updated tests, changed config...")
```

**Good:**
```
remember(content="JWT: using RS256, access token TTL=15min, refresh=7d", tags="auth,jwt,decision")
remember(content="session store: race condition on concurrent login — fix: Redis SETNX lock", tags="auth,bug,redis")
```

**Do NOT remember:** obvious facts, syntax, file contents (use git/search_code).

---

## Multi-agent Coordination

- Other agents see your project-scope entries
- Do not delete others' entries without reason
- On conflict — create a new entry with clarification
- Use `stats()` to check how many memories exist

---

## Consolidation

Periodically merge similar memories:

```
consolidate(dry_run=True)    # preview what will merge
consolidate(dry_run=False)   # execute merge
```

Source: episodic -> target: semantic (default). Similarity threshold: 0.85.
