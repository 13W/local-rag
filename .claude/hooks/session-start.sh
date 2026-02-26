#!/usr/bin/env bash
# Injected at session start and after context compaction.
# Output is delivered as a system-reminder — no dismissive framing.

cat <<'EOF'
=== MCP MEMORY PROTOCOL — ACTIVE ===

MANDATORY WORKFLOW (no exceptions):
  1. recall(query="task keywords")       → search past decisions, bugs, patterns
  2. search_code(query="description")    → semantic RAG over codebase
  3. [think + act]
  4. remember(content, memory_type, tags, importance) → store new knowledge

CODEBASE ORIENTATION (unknown codebase):
  project_overview()                     → directory tree, entry points, top imports

SEARCH REFERENCE:
  search_code(query)                               # hybrid mode (default, best)
  search_code(query, chunk_type="function")        # filter by symbol type
  search_code(query, search_mode="semantic")       # conceptual, no exact name
  get_file_context(file_path)                      # file content + symbol index
  get_file_context(file_path, symbol_name="Foo")   # single symbol
  get_dependencies(file_path, direction="imported_by")  # impact before editing

MEMORY TYPES:
  episodic   → bugs, events (time-decayed)
  semantic   → architecture, decisions (long-lived)
  procedural → patterns, conventions

SCOPE:
  project → shared with all agents  |  agent → private  |  global → all projects

TOOL DIVISION (serena + this MCP complement each other):
  Find code by meaning         → search_code
  Find symbol by exact name    → serena find_symbol
  Edit / replace a symbol      → serena replace_symbol_body
  Check who imports a file     → get_dependencies
  Store a decision             → remember

Skipping steps 1–2 is a workflow error. Skipping step 4 loses knowledge.
EOF
