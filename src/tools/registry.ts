import { rememberTool }         from "./remember.js";
import { recallTool }           from "./recall.js";
import { searchCodeTool }       from "./search_code.js";
import { forgetTool }           from "./forget.js";
import { consolidateTool }      from "./consolidate.js";
import { statsTool }            from "./stats.js";
import { getFileContextTool }   from "./get_file_context.js";
import { getDependenciesTool }  from "./get_dependencies.js";
import { projectOverviewTool }  from "./project_overview.js";
import { getSymbolTool }        from "./get_symbol.js";
import { findUsagesTool }       from "./find_usages.js";
import { requestValidationTool } from "./request-validation.js";
import { giveFeedbackTool }      from "./give_feedback.js";
import type { Status }           from "../types.js";

// ── Tool definitions (JSON Schema) ──────────────────────────────────────────

export const TOOLS = [
  {
    name: "remember",
    description:
      "Store a memory.\n\nArgs:\n  content: Text to remember (fact, decision, pattern, incident)\n  memory_type: \"episodic\" (events), \"semantic\" (facts), \"procedural\" (patterns)\n  scope: \"agent\" (private), \"project\" (shared), \"global\" (all projects)\n  tags: Comma-separated tags: \"auth,jwt,security\"\n  importance: 0.0 to 1.0 (0.8+ for critical knowledge)\n  ttl_hours: Time to live in hours (0 = forever)",
    inputSchema: {
      type: "object" as const,
      properties: {
        content:     { type: "string",  description: "Text to remember (fact, decision, pattern, incident)" },
        memory_type: { type: "string",  description: "Memory type", default: "semantic", enum: ["episodic", "semantic", "procedural"] },
        scope:       { type: "string",  description: "Visibility scope", default: "project", enum: ["agent", "project", "global"] },
        tags:        { type: "string",  description: "Comma-separated tags: \"auth,jwt,security\"", default: "" },
        importance:  { type: "number",  description: "0.0–1.0 (0.8+ for critical knowledge)", default: 0.5 },
        ttl_hours:   { type: "integer", description: "TTL in hours; 0 = forever", default: 0 },
      },
      required: ["content"],
    },
  },
  {
    name: "recall",
    description: "Semantic search across memory. Use BEFORE every action.\n\nArgs:\n  query: What to search for (natural language)\n  memory_type: Filter: \"episodic\", \"semantic\", \"procedural\", \"\" = all\n  scope: Filter: \"agent\", \"project\", \"global\", \"\" = all\n  tags: Filter by comma-separated tags\n  limit: Number of results (1-20)\n  min_relevance: Minimum relevance score (0.0-1.0)\n  time_decay: Penalize older memories\n  llm_filter: Use LLM to filter out semantically irrelevant results (default True)",
    inputSchema: {
      type: "object" as const,
      properties: {
        query:         { type: "string",  description: "Natural language search query" },
        memory_type:   { type: "string",  description: "Filter by type (empty = all)", default: "", enum: ["", "episodic", "semantic", "procedural"] },
        scope:         { type: "string",  description: "Filter by scope (empty = all)", default: "", enum: ["", "agent", "project", "global"] },
        tags:          { type: "string",  description: "Comma-separated tag filter", default: "" },
        limit:         { type: "integer", description: "Max results (1–20)", default: 5 },
        min_relevance: { type: "number",  description: "Min similarity score 0.0–1.0", default: 0.3 },
        time_decay:    { type: "boolean", description: "Penalise older memories", default: true },
        llm_filter:    { type: "boolean", description: "Use LLM to filter irrelevant results", default: true },
      },
      required: ["query"],
    },
  },
  {
    name: "search_code",
    description: "Semantic search over the codebase (RAG).\n\nArgs:\n  query: What to find — natural language description\n  file_path: Filter by file path substring: \"src/auth\"\n  chunk_type: Filter: \"function\", \"class\", \"interface\", \"type_alias\", \"enum\"\n  limit: Number of results (1-20)\n  search_mode: \"hybrid\" (default, RRF fusion), \"code\" (code vector), \"semantic\" (description vector)\n  rerank: Cross-encoder reranking for higher precision (default false)\n  rerank_k: ANN candidates to fetch before reranking (default 50)\n  top: Results to return after reranking (default: limit)",
    inputSchema: {
      type: "object" as const,
      properties: {
        query:       { type: "string",  description: "Natural language description" },
        file_path:   { type: "string",  description: "File path substring filter: \"src/auth\"", default: "" },
        chunk_type:  { type: "string",  description: "Filter by symbol type (empty = all)", default: "", enum: ["", "function", "class", "interface", "type_alias", "enum"] },
        limit:       { type: "integer", description: "Max results (1–20)", default: 10 },
        search_mode: { type: "string",  description: "hybrid (default, RRF fusion), code (code vector), semantic (description vector), lexical (text index filter)", default: "hybrid", enum: ["hybrid", "code", "semantic", "lexical"] },
        rerank:        { type: "boolean", description: "Cross-encoder reranking for higher precision", default: false },
        rerank_k:      { type: "integer", description: "ANN candidates to fetch before reranking", default: 50 },
        top:           { type: "integer", description: "Results to return after reranking (default: limit)", default: 10 },
        name_pattern:  { type: "string",  description: "Filter by symbol name substring (e.g. \"use*\" for React hooks)", default: "" },
        branch:        { type: "string",  description: "Override branch filter (default: current branch)", default: "" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_symbol",
    description: "Retrieve a symbol by its UUID from search_code results. Direct Qdrant lookup — no file I/O.\n\nArgs:\n  symbol_id: UUID of the symbol (from search_code `id:` field)",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol_id: { type: "string", description: "UUID of the symbol from search_code results" },
      },
      required: ["symbol_id"],
    },
  },
  {
    name: "find_usages",
    description: "Find symbols that reference or use a given symbol. Two-leg search: lexical (name/content match) + semantic (similar meaning). Merged by UUID, lexical hits first.\n\nArgs:\n  symbol_id: UUID of the symbol (from search_code or get_symbol)\n  limit: Max results (1–50, default 20)",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol_id: { type: "string",  description: "UUID of the symbol (from search_code or get_symbol)" },
        limit:     { type: "integer", description: "Max results (1–50)", default: 20 },
      },
      required: ["symbol_id"],
    },
  },
  {
    name: "forget",
    description: "Delete a memory by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        memory_id: { type: "string", description: "UUID of the memory to delete" },
      },
      required: ["memory_id"],
    },
  },
  {
    name: "consolidate",
    description: "Consolidate similar memories (like sleep for the brain).\\n\\nArgs:\\n  source: Source memory type\\n  target: Target memory type for merged records\\n  similarity_threshold: Cosine similarity threshold (0.0-1.0)\\n  dry_run: True = preview only, False = execute",
    inputSchema: {
      type: "object" as const,
      properties: {
        source:               { type: "string",  description: "episodic | semantic | procedural | memory | memory_agents", default: "episodic", enum: ["episodic", "semantic", "procedural", "memory", "memory_agents"] },
        target:               { type: "string",  description: "episodic | semantic | procedural | memory | memory_agents", default: "semantic", enum: ["episodic", "semantic", "procedural", "memory", "memory_agents"] },
        similarity_threshold: { type: "number",  description: "Cosine similarity threshold 0.0–1.0", default: 0.85 },
        dry_run:              { type: "boolean", description: "Preview without executing", default: true },
      },
      required: [],
    },
  },
  {
    name: "stats",
    description: "Memory and codebase statistics.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_file_context",
    description: "Read a file or a fragment around a specific symbol/line range.\n\nArgs:\n  file_path: Relative path to the file (from project root)\n  symbol_name: Name of a function/class/type to centre the view on\n  start_line: First line of the window (if no symbol_name)\n  end_line: Last line of the window (if no symbol_name)\n  context_lines: Lines of context around the symbol (default 10)",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path:     { type: "string",  description: "Relative file path from project root" },
        symbol_name:   { type: "string",  description: "Name of function/class/type to find", default: "" },
        start_line:    { type: "integer", description: "Start of line window",                 default: 0 },
        end_line:      { type: "integer", description: "End of line window",                   default: 0 },
        context_lines: { type: "integer", description: "Lines of context around symbol",       default: 10 },
      },
      required: ["file_path"],
    },
  },
  {
    name: "get_dependencies",
    description: "Show import dependencies of a file.\n\nArgs:\n  file_path: Relative path to the file\n  direction: \"imports\" (what it imports), \"imported_by\" (who imports it), \"both\"\n  depth: Traversal depth 1–5 (default 1)",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path:  { type: "string",  description: "Relative file path" },
        direction:  { type: "string",  description: "Dependency direction", default: "both", enum: ["both", "imports", "imported_by"] },
        depth:      { type: "integer", description: "Traversal depth 1–5", default: 1 },
      },
      required: ["file_path"],
    },
  },
  {
    name: "project_overview",
    description: "Return a high-level map of the project: directory structure, entry points, language stats, index size, and most-imported modules.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "request_validation",
    description:
      "Ask Claude to confirm a proposed memory update before writing to Qdrant.\n" +
      "Called by the router when its confidence is between 0.5 and 0.75.\n" +
      "Above 0.75 the router writes directly. Below 0.5 it discards silently.\n\n" +
      "Respond with exactly one of:\n" +
      "  confirmed            — write the entry as proposed\n" +
      "  corrected:<status>   — write with a corrected status (e.g. corrected:resolved)\n" +
      "  skip                 — discard; this entry is irrelevant or incorrect",
    inputSchema: {
      type: "object" as const,
      properties: {
        proposed_text:   { type: "string", description: "What the router wants to remember" },
        proposed_status: {
          type: "string",
          description: "Status the router assigned",
          enum: ["in_progress", "resolved", "open_question", "hypothesis"],
        },
        similar_entry: {
          type: "string",
          description: "Existing Qdrant entry found nearby (empty string when none)",
          default: "",
        },
        question: { type: "string", description: "Specific question the router has" },
      },
      required: ["proposed_text", "proposed_status", "question"],
    },
  },
  {
    name: "give_feedback",
    description:
      "Record feedback about MCP tools and hooks used in this session.\n\n" +
      "Call at the end of a session with your honest assessment:\n" +
      "- Which tools did you use, and were they helpful?\n" +
      "- Did you read and act on context injected by UserPromptSubmit / SessionStart hooks?\n" +
      "  Or did you ignore it and start from scratch? Why?\n" +
      "- What would make the system more useful in future sessions?\n\n" +
      "Args:\n" +
      "  content: Markdown feedback — no restrictions on length or format\n" +
      "  session_id: Session ID from the SessionEnd hook message (optional)",
    inputSchema: {
      type: "object" as const,
      properties: {
        content:    { type: "string", description: "Markdown feedback (no restrictions)" },
        session_id: { type: "string", description: "Session ID (optional)", default: "" },
        agent_type: { type: "string", description: "Agent type hint (optional)", default: "" },
      },
      required: ["content"],
    },
  },
];

// Fast name→tool lookup used for validation
export const TOOL_MAP = new Map(TOOLS.map(t => [t.name, t]));

// ── Argument helpers ─────────────────────────────────────────────────────────

function str(v: unknown, def = ""): string    { return typeof v === "string"  ? v : def; }
function num(v: unknown, def: number): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") { const n = Number(v); if (!Number.isNaN(n)) return n; }
  return def;
}
function int(v: unknown, def: number): number {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string" && v !== "") { const n = Number(v); if (!Number.isNaN(n)) return Math.trunc(n); }
  return def;
}
function bool(v: unknown, def: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return def;
}

// ── Tool dispatch ─────────────────────────────────────────────────────────────

export async function dispatchTool(name: string, a: Record<string, unknown>): Promise<string> {
  if (name === "remember") {
    return rememberTool({
      content:     str(a["content"]),
      memory_type: str(a["memory_type"], "semantic"),
      scope:       str(a["scope"],       "project"),
      tags:        str(a["tags"],        ""),
      importance:  num(a["importance"],  0.5),
      ttl_hours:   int(a["ttl_hours"],   0),
    });
  }
  if (name === "recall") {
    return recallTool({
      query:         str(a["query"]),
      memory_type:   str(a["memory_type"],   ""),
      scope:         str(a["scope"],         ""),
      tags:          str(a["tags"],          ""),
      limit:         int(a["limit"],         5),
      min_relevance: num(a["min_relevance"], 0.3),
      time_decay:    bool(a["time_decay"],   true),
      llm_filter:    bool(a["llm_filter"],   true),
    });
  }
  if (name === "search_code") {
    return searchCodeTool({
      query:        str(a["query"]),
      file_path:    str(a["file_path"],    ""),
      chunk_type:   str(a["chunk_type"],   ""),
      limit:        int(a["limit"],        10),
      search_mode:  str(a["search_mode"],  "hybrid") as "hybrid" | "lexical" | "semantic" | "code",
      rerank:       bool(a["rerank"],      false),
      rerank_k:     int(a["rerank_k"],     50),
      top:          int(a["top"],          10),
      name_pattern: str(a["name_pattern"], ""),
      branch:       str(a["branch"],       ""),
    });
  }
  if (name === "get_symbol") {
    return getSymbolTool({ symbol_id: str(a["symbol_id"]) });
  }
  if (name === "find_usages") {
    return findUsagesTool({
      symbol_id: str(a["symbol_id"]),
      limit:     int(a["limit"], 20),
    });
  }
  if (name === "forget") {
    return forgetTool({ memory_id: str(a["memory_id"]) });
  }
  if (name === "consolidate") {
    return consolidateTool({
      source:               str(a["source"],               "episodic"),
      target:               str(a["target"],               "semantic"),
      similarity_threshold: num(a["similarity_threshold"], 0.85),
      dry_run:              bool(a["dry_run"],              true),
    });
  }
  if (name === "stats") {
    return statsTool();
  }
  if (name === "get_file_context") {
    return getFileContextTool({
      file_path:     str(a["file_path"]),
      symbol_name:   str(a["symbol_name"],   ""),
      start_line:    int(a["start_line"],    0),
      end_line:      int(a["end_line"],      0),
      context_lines: int(a["context_lines"], 10),
    });
  }
  if (name === "get_dependencies") {
    return getDependenciesTool({
      file_path: str(a["file_path"]),
      direction: str(a["direction"], "both"),
      depth:     int(a["depth"],     1),
    });
  }
  if (name === "project_overview") {
    return projectOverviewTool();
  }
  if (name === "request_validation") {
    return requestValidationTool({
      proposed_text:   str(a["proposed_text"]),
      proposed_status: str(a["proposed_status"]) as Status,
      similar_entry:   str(a["similar_entry"],   ""),
      question:        str(a["question"]),
    });
  }
  if (name === "give_feedback") {
    return giveFeedbackTool({
      content:    str(a["content"]),
      session_id: str(a["session_id"], ""),
      agent_type: str(a["agent_type"], ""),
    });
  }
  return `unknown tool: ${name}`;
}
