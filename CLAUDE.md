# CLAUDE.md — Distributed Memory & Code RAG Protocol

> **Hooks enforce this protocol at every session start and on every prompt.**
> Skipping steps 1–2 is a workflow error. Skipping step 4 loses knowledge.

## MANDATORY CHECKLIST — every task, no exceptions

| Step | Call | Purpose |
|------|------|---------|
| 1 | `recall(query="task keywords")` | Past decisions, bugs, patterns |
| 2 | `search_code(query="description")` | Semantic RAG over codebase |
| 3 | Think + Act | — |
| 4 | `remember(content, memory_type, tags, importance)` | Store new knowledge |

If codebase is **unknown**: call `project_overview()` before step 2.

---

## You are connected to a shared memory and RAG system via MCP

Tools: `recall`, `remember`, `search_code`, `get_file_context`, `get_dependencies`, `project_overview`, `forget`, `consolidate`, `stats`.
Other agents share the same project-scope memory.

---

## Search reference

```
search_code(query)                                    # hybrid mode (default, best)
search_code(query, chunk_type="function")             # filter by symbol type
search_code(query, search_mode="semantic")            # conceptual, unknown name
search_code(query, file_path="src/core")              # restrict to path

get_file_context(file_path)                           # file content + symbol index
get_file_context(file_path, symbol_name="verifyToken")
get_file_context(file_path, start_line=40, end_line=80)

get_dependencies(file_path)                           # imports + imported_by
get_dependencies(file_path, direction="imported_by")  # who breaks if I change this?
get_dependencies(file_path, depth=3)                  # transitive deps

project_overview()                                    # dir tree, entry points, top imports
```

Search modes:
- `hybrid` (default) — best results in most cases
- `code` — exact structural match
- `semantic` — conceptual search when you don't know the name

---

## Tool division: this MCP + Serena

| Task | Use |
|------|-----|
| Find code by meaning / concept | `search_code` |
| Find a symbol by exact name | Serena `find_symbol` |
| Understand project structure | `project_overview` |
| Read a file / symbol body | Serena `find_symbol(include_body=True)` or `get_file_context` |
| Check who imports a file | `get_dependencies(direction="imported_by")` |
| Find all references to a symbol | Serena `find_referencing_symbols` |
| Edit / replace a symbol | Serena `replace_symbol_body` |
| Rename across codebase | Serena `rename_symbol` |
| Store a decision | `remember` |
| Retrieve past decisions | `recall` |

> ❌ Do NOT use `mcp__serena__search_for_pattern` instead of `search_code`.
> Serena's pattern search is regex-only and does not understand meaning.

### Workflow

```
# 1. Orient
project_overview()                      # if codebase is unknown
recall(query="task keywords")

# 2. Find
search_code(query="what you're looking for")       # semantic discovery
find_symbol("SymbolName", include_body=True)       # precise read once you know the name

# 3. Impact check
get_dependencies(file_path, direction="imported_by")

# 4. Edit
find_referencing_symbols("SymbolName")             # check call sites
replace_symbol_body("SymbolName", ...)

# 5. Remember
remember(content="...", memory_type="...", tags="...", importance=0.8)
```

---

## remember() — rules

**Memory types:**
- `episodic` — bugs, events (time-decayed)
- `semantic` — architecture, decisions (long-lived)
- `procedural` — patterns, conventions

**Scope:** `project` (shared with agents) | `agent` (private) | `global` (all projects)

| Situation | memory_type | importance |
|-----------|-------------|------------|
| Architectural decision | semantic | 0.8–1.0 |
| Bug found and fixed | episodic | 0.6–0.8 |
| New pattern / convention | procedural | 0.7–0.9 |
| Intermediate result | episodic | 0.3–0.5 |
| Business logic fact | semantic | 0.7–0.9 |

**Size limit:** embedder truncates at 2000 chars. One entry = one fact.

```
remember(
  content="OrderService.create() race condition under concurrent requests — fix: Redis SETNX lock",
  memory_type="episodic",
  tags="bug,orders,concurrency,redis",
  importance=0.8
)
```

Do **not** remember: syntax, file contents, obvious facts (those live in git + `search_code`).

---

## Tags

- Area: `auth`, `api`, `db`, `frontend`, `backend`, `infra`, `ci`
- Type: `bug`, `decision`, `pattern`, `refactoring`, `security`
- Framework: `router`, `middleware`, `config`, `schema`, `plugin`

---

## Multi-agent

```
stats()              # total memory count
consolidate(dry_run=True)   # preview merges
consolidate(dry_run=False)  # execute
```

- Other agents see your `project`-scope entries
- Do not delete others' entries without reason
- On conflict — add a new entry with clarification
