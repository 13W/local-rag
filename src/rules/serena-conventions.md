# Serena MCP — Conventions & Workflows

## When to Use Serena vs Memory MCP

| You want to... | Use |
|----------------|-----|
| Discover code by meaning/concept | `search_code` (Memory MCP) first |
| Find a symbol you already know the name of | `find_symbol` (Serena) |
| Read a symbol's full body | `find_symbol(include_body=True)` (Serena) |
| Get an overview of symbols in a file | `get_symbols_overview` (Serena) |
| Find who calls/references a symbol | `find_referencing_symbols` (Serena) |
| Check what imports a file / who imports it | `get_dependencies` (Memory MCP) |
| Edit/replace a symbol's definition | `replace_symbol_body` (Serena) |
| Add code after/before a symbol | `insert_after_symbol` / `insert_before_symbol` (Serena) |
| Rename a symbol across the codebase | `rename_symbol` (Serena) |
| Search for regex patterns in non-code files | `search_for_pattern` (Serena) |

---

## get_symbols_overview — File Discovery

First step when exploring a new file:

```
get_symbols_overview(relative_path="src/auth/jwt.ts")              # top-level symbols
get_symbols_overview(relative_path="src/auth/jwt.ts", depth=1)     # + immediate children (methods)
```

Use this to understand a file before reading specific symbols.

---

## find_symbol — Precise Symbol Lookup

### Name path patterns

- Simple name: `"verifyToken"` — matches any symbol with that name
- Relative path: `"AuthService/verifyToken"` — matches name path suffix
- Absolute path: `"/AuthService/verifyToken"` — exact match within file
- With index: `"AuthService/verifyToken[1]"` — specific overload

### Parameters

- `name_path_pattern` (required)
- `relative_path` — restrict to file/directory (speeds up search significantly)
- `depth` — retrieve children (e.g., `depth=1` for class methods)
- `include_body` — include source code (use judiciously)
- `include_info` — include hover info / docstring (ignored if include_body=True)
- `substring_matching` — match partial names (e.g., `"Foo/get"` matches `"Foo/getValue"`)

### Typical patterns

```
# Get class with all its methods (no bodies)
find_symbol("MyClass", depth=1, include_body=False)

# Read specific method body
find_symbol("MyClass/myMethod", include_body=True, relative_path="src/services/my.ts")

# Find all symbols containing "auth" in name
find_symbol("auth", substring_matching=True)
```

---

## Editing Workflow

### replace_symbol_body — Replace entire symbol

1. Read the symbol first: `find_symbol("SymbolName", include_body=True)`
2. Check references: `find_referencing_symbols("SymbolName", relative_path="...")`
3. Replace: `replace_symbol_body("SymbolName", relative_path="...", body="new code")`

**Body includes:** the full definition including signature line.
**Body does NOT include:** preceding comments, docstrings, or imports.

### insert_after_symbol / insert_before_symbol

- `insert_after_symbol` with the last top-level symbol = add code at end of file
- `insert_before_symbol` with the first top-level symbol = add code at beginning of file

```
# Add a new function after an existing one
insert_after_symbol("existingFunction", relative_path="src/utils.ts", body="function newFunc() { ... }")
```

### rename_symbol — Codebase-wide rename

```
rename_symbol("oldName", relative_path="src/services/my.ts", new_name="newName")
```

Renames across the entire codebase. For overloaded methods (Java), include signature in name_path.

---

## find_referencing_symbols — Impact Analysis

```
find_referencing_symbols("SymbolName", relative_path="src/services/my.ts")
```

Returns: metadata about referencing symbols + code snippets around each reference.

Always use before editing a symbol to ensure backward compatibility or to find all call sites that need updating.

---

## search_for_pattern — Regex Search

Use for non-code files (HTML, YAML, config) or when you need regex patterns:

```
search_for_pattern(substring_pattern="TODO|FIXME", restrict_search_to_code_files=True)
search_for_pattern(substring_pattern="apiVersion:.*v2", paths_include_glob="*.yaml")
```

**Do NOT use** as a substitute for `search_code` — it's regex-only and doesn't understand meaning.

---

## Do Not Duplicate Work

- If you know the exact symbol name -> use Serena `find_symbol` directly (skip `search_code`)
- If you need broad discovery -> use `search_code` first, then Serena for precise reads
- If you already read a full file -> don't re-analyze with symbolic tools (you have the info)
- `get_file_context` (Memory MCP) is useful when you need indexed symbol metadata alongside source

---

## Recommended End-to-End Workflow

```
# 1. Orient
project_overview()
recall(query="task keywords")

# 2. Discover
search_code(query="what you're looking for")

# 3. Read precisely
find_symbol("SymbolName", include_body=True)

# 4. Assess impact
get_dependencies(file_path="src/found/file.ts", direction="imported_by")
find_referencing_symbols("SymbolName", relative_path="src/found/file.ts")

# 5. Edit
replace_symbol_body("SymbolName", relative_path="src/found/file.ts", body="...")

# 6. Remember
remember(content="What changed and why", memory_type="semantic", tags="...", importance=0.8)
```
