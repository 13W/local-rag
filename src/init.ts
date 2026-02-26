import { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SESSION_START_SH = `#!/usr/bin/env bash
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
`;

const PROMPT_REMINDER_SH = `#!/usr/bin/env bash
# Fires on every user prompt. Injects a short protocol motto (~20 tokens).
# Idea borrowed from claude-core-values: per-prompt motto reinforcement.

echo "[MCP] BEFORE acting: recall() + search_code(). AFTER acting: remember()."
`;

const SETTINGS_HOOKS = {
  hooks: {
    SessionStart: [
      {
        matcher: "",
        hooks: [{ type: "command", command: "bash .claude/hooks/session-start.sh", timeout: 5 }],
      },
    ],
    UserPromptSubmit: [
      {
        matcher: "",
        hooks: [{ type: "command", command: "bash .claude/hooks/prompt-reminder.sh", timeout: 3 }],
      },
    ],
  },
};

export function init(cwd: string = process.cwd()): void {
  const hooksDir = join(cwd, ".claude", "hooks");
  mkdirSync(hooksDir, { recursive: true });

  const sessionStart = join(hooksDir, "session-start.sh");
  writeFileSync(sessionStart, SESSION_START_SH);
  chmodSync(sessionStart, 0o755);
  process.stdout.write("wrote  .claude/hooks/session-start.sh\n");

  const promptReminder = join(hooksDir, "prompt-reminder.sh");
  writeFileSync(promptReminder, PROMPT_REMINDER_SH);
  chmodSync(promptReminder, 0o755);
  process.stdout.write("wrote  .claude/hooks/prompt-reminder.sh\n");

  const settingsPath = join(cwd, ".claude", "settings.json");
  const existing: Record<string, unknown> = existsSync(settingsPath)
    ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>)
    : {};

  const merged = { ...existing, ...SETTINGS_HOOKS };
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");
  process.stdout.write("wrote  .claude/settings.json\n");

  process.stdout.write(
    "\nDone. Commit .claude/hooks/ and .claude/settings.json to share hooks with your team.\n",
  );
}
