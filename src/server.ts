import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { ensureCollections } from "./qdrant.js";
import { record, startDashboard, broadcastShutdown, broadcastError } from "./dashboard.js";
import { CodeIndexer }  from "./indexer/indexer.js";
import { startWatcher } from "./indexer/watcher.js";
import { cfg } from "./config.js";
import { rememberTool }         from "./tools/remember.js";
import { recallTool }           from "./tools/recall.js";
import { searchCodeTool }       from "./tools/search_code.js";
import { forgetTool }           from "./tools/forget.js";
import { consolidateTool }      from "./tools/consolidate.js";
import { statsTool }            from "./tools/stats.js";
import { getFileContextTool }   from "./tools/get_file_context.js";
import { getDependenciesTool }  from "./tools/get_dependencies.js";
import { projectOverviewTool }  from "./tools/project_overview.js";

// ── Tool definitions (JSON Schema) ──────────────────────────────────────────

const TOOLS = [
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
    description: "Semantic search over the codebase (RAG).\n\nArgs:\n  query: What to find — natural language description\n  file_path: Filter by file path substring: \"src/auth\"\n  chunk_type: Filter: \"function\", \"class\", \"interface\", \"type_alias\", \"enum\"\n  limit: Number of results (1-20)\n  search_mode: \"hybrid\" (default, RRF fusion), \"code\" (code vector), \"semantic\" (description vector)",
    inputSchema: {
      type: "object" as const,
      properties: {
        query:       { type: "string",  description: "Natural language description" },
        file_path:   { type: "string",  description: "File path substring filter: \"src/auth\"", default: "" },
        chunk_type:  { type: "string",  description: "Filter by symbol type (empty = all)", default: "", enum: ["", "function", "class", "interface", "type_alias", "enum"] },
        limit:       { type: "integer", description: "Max results (1–20)", default: 10 },
        search_mode: { type: "string",  description: "Search algorithm", default: "hybrid", enum: ["hybrid", "code", "semantic"] },
      },
      required: ["query"],
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
    description: "Consolidate similar memories (like sleep for the brain).\n\nArgs:\n  source: Source memory type\n  target: Target memory type for merged records\n  similarity_threshold: Cosine similarity threshold (0.0-1.0)\n  dry_run: True = preview only, False = execute",
    inputSchema: {
      type: "object" as const,
      properties: {
        source:               { type: "string",  description: "episodic | semantic | procedural", default: "episodic", enum: ["episodic", "semantic", "procedural"] },
        target:               { type: "string",  description: "episodic | semantic | procedural", default: "semantic", enum: ["episodic", "semantic", "procedural"] },
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
];

// Fast name→tool lookup used for validation
const TOOL_MAP = new Map(TOOLS.map(t => [t.name, t]));

// ── Argument helpers ─────────────────────────────────────────────────────────

function str(v: unknown, def = ""): string    { return typeof v === "string"  ? v : def; }
function num(v: unknown, def: number): number { return typeof v === "number"  ? v : def; }
function int(v: unknown, def: number): number { return typeof v === "number"  ? Math.trunc(v) : def; }
function bool(v: unknown, def: boolean): boolean { return typeof v === "boolean" ? v : def; }

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
      query:       str(a["query"]),
      file_path:   str(a["file_path"],   ""),
      chunk_type:  str(a["chunk_type"],  ""),
      limit:       int(a["limit"],       10),
      search_mode: str(a["search_mode"], "hybrid"),
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
  return `unknown tool: ${name}`;
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "Claude Memory + Code RAG", version: "2.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const a = (request.params.arguments ?? {}) as Record<string, unknown>;

  // 1. Validate tool exists
  const tool = TOOL_MAP.get(name);
  if (!tool) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }

  // 2. Validate required arguments are present
  const required = (tool.inputSchema.required ?? []) as string[];
  const missing = required.filter(k => !(k in a));
  if (missing.length > 0) {
    throw new McpError(ErrorCode.InvalidParams, `Missing required argument(s): ${missing.join(", ")}`);
  }

  const bytesIn = JSON.stringify(a).length;
  const t0 = Date.now();

  // 3. Execute; wrap unexpected errors as InternalError
  try {
    const text = await dispatchTool(name, a);
    record(name, "mcp", bytesIn, text.length, Date.now() - t0, true);
    return { content: [{ type: "text" as const, text }] };
  } catch (err) {
    record(name, "mcp", bytesIn, 0, Date.now() - t0, false);
    if (err instanceof McpError) throw err;
    throw new McpError(
      ErrorCode.InternalError,
      err instanceof Error ? err.message : String(err),
    );
  }
});

// ── Global error capture ─────────────────────────────────────────────────────

process.on("uncaughtException", (err: Error) => {
  process.stderr.write(`[memory] uncaughtException: ${err.stack ?? err.message}\n`);
  if (cfg.dashboard) broadcastError(err);
  setTimeout(() => process.exit(1), 250);
});

process.on("unhandledRejection", (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  process.stderr.write(`[memory] unhandledRejection: ${err.stack ?? err.message}\n`);
  if (cfg.dashboard) broadcastError(err);
  setTimeout(() => process.exit(1), 250);
});

// ── Startup ──────────────────────────────────────────────────────────────────

await ensureCollections();
if (cfg.dashboard) startDashboard(cfg.dashboardPort, TOOLS, dispatchTool);
if (cfg.watch) {
  const root = cfg.projectRoot || process.cwd();
  const indexer = new CodeIndexer({ generateDescriptions: cfg.generateDescriptions });
  startWatcher(root, indexer, (relPath, chunks) => {
    server.notification({
      method: "notifications/message",
      params: { level: "info", logger: "watcher", data: `Reindexed ${relPath}: ${chunks} chunks` },
    }).catch((err: unknown) => {
      process.stderr.write(`[watcher] notification error: ${String(err)}\n`);
    });
  });
}
process.stderr.write("[memory] MCP server ready\n");

const transport = new StdioServerTransport();
await server.connect(transport);

process.stdin.once("close", () => {
  if (cfg.dashboard) broadcastShutdown();
  server.close().finally(() => process.exit(0));
});
