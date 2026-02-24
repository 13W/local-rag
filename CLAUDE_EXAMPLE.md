# Distributed Memory & Code RAG Protocol

## You are connected to a shared memory and RAG system via MCP

You have 9 tools: `recall`, `remember`, `search_code`, `get_file_context`, `get_dependencies`, `project_overview`, `forget`, `consolidate`, `stats`.
Other agents are connected to the same memory — you share a common project-scope.

---

## Protocol: RECALL + SEARCH_CODE → THINK → ACT → REMEMBER

### RECALL + SEARCH_CODE — before every action

**Both steps are required** when receiving any task:

**Step 1 — Search memory:**
```
recall(query="keywords from the task")
```
Searches past decisions, bugs, patterns. Does NOT search code.

**Step 2 — Search code (always, even on familiar codebases):**
```
search_code(query="what you are looking for")
```
Semantic RAG over the indexed codebase.

> ❌ Do NOT substitute `mcp__serena__search_for_pattern` for `search_code`.
> Serena's pattern search is regex-only, requires an active project, and does not understand meaning.
> Use `search_code` first — then use Serena to read/edit specific symbols once you know their names.

When to recall:
- Before changing any code — look for patterns and past solutions
- When debugging — recall by error description (episodic)
- When making an architectural decision — recall by topic (semantic)

Memory types:
- `episodic` — events, bugs, what happened (has time decay)
- `semantic` — facts, knowledge, architecture (long-lived)
- `procedural` — patterns, conventions, "how to do things"

---

### CODEBASE ORIENTATION

**If project structure is unknown — start with an overview:**
```
project_overview()
```
Returns: directory tree (3 levels), entry points, language stats, indexed file count, top-10 most-imported modules.

**Always find relevant code via semantic search (required step):**
```
search_code(query="natural language description")
search_code(query="router middleware auth", chunk_type="function")
search_code(query="config validation", file_path="src/core", search_mode="semantic")
```

Search modes (`search_mode`):
- `hybrid` (default) — RRF fusion of code + description vectors, best results in most cases
- `code` — code vector only (exact structural matches)
- `semantic` — description vector only (conceptual search when you don't know the name)

**Read a specific file or symbol after finding it via search_code:**
```
get_file_context(file_path="src/auth/jwt.ts")
get_file_context(file_path="src/auth/jwt.ts", symbol_name="verifyToken")
get_file_context(file_path="src/auth/jwt.ts", start_line=40, end_line=80)
```
Also returns a list of all indexed symbols in the file with line ranges.

**Before modifying a file — check what will break:**
```
get_dependencies(file_path="src/auth/jwt.ts")                           # imports + imported_by
get_dependencies(file_path="src/auth/jwt.ts", direction="imported_by")  # who depends on this file
get_dependencies(file_path="src/auth/jwt.ts", depth=3)                  # transitive dependencies
```

---

### WORKING WITH SERENA

Serena provides filesystem access and precise symbolic code editing.
This MCP provides semantic search and memory.
**They complement each other — use both.**

#### Division of responsibilities

| Task | Use |
|------|-----|
| Find code by meaning / concept | `search_code` (this MCP) |
| Find a symbol by exact name | Serena `find_symbol` |
| Understand project structure | `project_overview` (this MCP) |
| Read a specific file / symbol body | Serena `find_symbol(include_body=True)` or `get_file_context` |
| Check what imports a file | `get_dependencies` (this MCP) |
| Find all references to a symbol | Serena `find_referencing_symbols` |
| Edit / replace a symbol | Serena `replace_symbol_body` |
| Rename a symbol across codebase | Serena `rename_symbol` |
| Store a decision or pattern | `remember` (this MCP) |
| Retrieve past decisions | `recall` (this MCP) |

#### Recommended workflow

```
# 1. Orient (this MCP)
project_overview()
recall(query="task keywords")

# 2. Find (this MCP → Serena)
search_code(query="what you're looking for")   # semantic discovery
find_symbol("SymbolName", include_body=True)   # precise read once you know the name

# 3. Assess impact (this MCP)
get_dependencies(file_path="src/found/file.ts", direction="imported_by")

# 4. Edit (Serena)
find_referencing_symbols("SymbolName", ...)    # check call sites
replace_symbol_body("SymbolName", ...)         # make the change

# 5. Remember (this MCP)
remember(content="...", memory_type="...", tags="...", importance=0.8)
```

#### Do not duplicate work

- Don't use `search_code` when you already know the exact symbol name — use Serena `find_symbol` directly.
- Don't use Serena file reads for broad discovery — use `search_code` first to narrow the scope.
- `get_file_context` is useful when Serena is unavailable or when you need indexed symbol metadata alongside the source.

---

### THINK — analysis

Combine results from recall + search_code + file_context with the current task.
If you found relevant memories — follow them.
If search_code revealed a pattern — follow it.

### ACT — execution

Do the work. If you learn something new along the way — remember it immediately.

### REMEMBER — after acting

| Situation | memory_type | importance | scope |
|-----------|-------------|------------|-------|
| Architectural decision | semantic | 0.8-1.0 | project |
| Found and fixed a bug | episodic | 0.6-0.8 | project |
| New pattern / convention | procedural | 0.7-0.9 | project |
| Intermediate result | episodic | 0.3-0.5 | agent |
| Business logic fact | semantic | 0.7-0.9 | project |
| General knowledge (all projects) | semantic | 0.6-0.8 | global |

```
remember(
  content="OrderService.create() has a race condition under concurrent requests. Fix: distributed lock via Redis SETNX",
  memory_type="episodic",
  tags="bug,orders,concurrency,redis",
  importance=0.8
)
```

**Do not remember:** obvious facts, syntax, file contents (those are in git).

**Size limit:** the embedder truncates text at 2000 characters — anything longer is lost during search.
- Write concisely: one entry = one fact / one solution / one bug
- If you need to store more — split into multiple `remember` calls with different tags
- Do not pass file contents, full logs, or diffs to `remember` — use git and `search_code` for that

**Bad** — one entry for everything:
```
remember(content="Refactored auth module: rewrote JWT, added refresh tokens, fixed race condition in session store, updated tests, changed config...")
```
**Good** — separate entries:
```
remember(content="JWT: using RS256, access token TTL=15min, refresh=7d", tags="auth,jwt,decision")
remember(content="session store: race condition on concurrent login — fix: Redis SETNX lock", tags="auth,bug,redis")
```

---

## Tags

Use consistent tags:
- By area: `auth`, `api`, `db`, `frontend`, `backend`, `infra`, `ci`
- By type: `bug`, `decision`, `pattern`, `refactoring`, `security`
- By framework: `router`, `middleware`, `config`, `schema`, `plugin`

---

## Multi-agent

```
stats()  # how many memories exist
```

- Other agents see your project-scope entries
- Do not delete others' entries without reason
- On conflict — create a new entry with clarification

---

## Consolidation

Periodically (or on user request):
```
consolidate(dry_run=True)   # preview what will be merged
consolidate(dry_run=False)  # execute
```
