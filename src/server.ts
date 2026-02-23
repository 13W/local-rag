import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ensureCollections } from "./qdrant.js";
import { rememberTool }    from "./tools/remember.js";
import { recallTool }      from "./tools/recall.js";
import { searchCodeTool }  from "./tools/search_code.js";
import { forgetTool }      from "./tools/forget.js";
import { consolidateTool } from "./tools/consolidate.js";
import { statsTool }       from "./tools/stats.js";

// ── Tool definitions (JSON Schema) ──────────────────────────────────────────

const TOOLS = [
  {
    name: "remember",
    description:
      "Store a memory.\n\nArgs:\n  content: Text to remember (fact, decision, pattern, incident)\n  memory_type: \"episodic\" (events), \"semantic\" (facts), \"procedural\" (patterns)\n  scope: \"agent\" (private), \"project\" (shared), \"global\" (all projects)\n  tags: Comma-separated tags: \"auth,jwt,security\"\n  importance: 0.0 to 1.0 (0.8+ for critical knowledge)\n  ttl_hours: Time to live in hours (0 = forever)",
    inputSchema: {
      type: "object" as const,
      properties: {
        content:     { type: "string",  description: "Text to remember" },
        memory_type: { type: "string",  description: "episodic | semantic | procedural", default: "semantic" },
        scope:       { type: "string",  description: "agent | project | global",         default: "project" },
        tags:        { type: "string",  description: "Comma-separated tags",             default: "" },
        importance:  { type: "number",  description: "0.0–1.0",                         default: 0.5 },
        ttl_hours:   { type: "integer", description: "TTL in hours; 0 = forever",        default: 0 },
      },
      required: ["content"],
    },
  },
  {
    name: "recall",
    description:
      "Semantic search across memory. Use BEFORE every action.\n\nArgs:\n  query: What to search for (natural language)\n  memory_type: Filter: \"episodic\", \"semantic\", \"procedural\", \"\" = all\n  scope: Filter: \"agent\", \"project\", \"global\", \"\" = all\n  tags: Filter by comma-separated tags\n  limit: Number of results (1-20)\n  min_relevance: Minimum relevance score (0.0-1.0)\n  time_decay: Penalize older memories\n  llm_filter: Use LLM to filter out semantically irrelevant results (default True)",
    inputSchema: {
      type: "object" as const,
      properties: {
        query:         { type: "string",  description: "Natural language search query" },
        memory_type:   { type: "string",  description: "episodic | semantic | procedural | (empty = all)", default: "" },
        scope:         { type: "string",  description: "agent | project | global | (empty = all)",         default: "" },
        tags:          { type: "string",  description: "Comma-separated tag filter",                       default: "" },
        limit:         { type: "integer", description: "Max results",                    default: 5 },
        min_relevance: { type: "number",  description: "Min similarity score 0.0–1.0",  default: 0.3 },
        time_decay:    { type: "boolean", description: "Penalise older memories",        default: true },
        llm_filter:    { type: "boolean", description: "Run LLM reranker",               default: true },
      },
      required: ["query"],
    },
  },
  {
    name: "search_code",
    description:
      "Semantic search over the codebase (RAG).\n\nArgs:\n  query: What to find — natural language description\n  file_path: Filter by file path substring: \"src/auth\"\n  chunk_type: Filter: \"function\", \"class\", \"interface\", \"type_alias\", \"enum\"\n  limit: Number of results (1-20)",
    inputSchema: {
      type: "object" as const,
      properties: {
        query:      { type: "string",  description: "Natural language description" },
        file_path:  { type: "string",  description: "File path substring filter",  default: "" },
        chunk_type: { type: "string",  description: "function | class | interface | type_alias | enum", default: "" },
        limit:      { type: "integer", description: "Max results",                  default: 10 },
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
    description:
      "Consolidate similar memories (like sleep for the brain).\n\nArgs:\n  source: Source memory type\n  target: Target memory type for merged records\n  similarity_threshold: Cosine similarity threshold (0.0-1.0)\n  dry_run: True = preview only, False = execute",
    inputSchema: {
      type: "object" as const,
      properties: {
        source:               { type: "string",  description: "Source memory type",       default: "episodic" },
        target:               { type: "string",  description: "Target memory type",       default: "semantic" },
        similarity_threshold: { type: "number",  description: "0.0–1.0",                 default: 0.85 },
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
];

// ── Argument helpers ─────────────────────────────────────────────────────────

function str(v: unknown, def = ""): string    { return typeof v === "string"  ? v : def; }
function num(v: unknown, def: number): number { return typeof v === "number"  ? v : def; }
function int(v: unknown, def: number): number { return typeof v === "number"  ? Math.trunc(v) : def; }
function bool(v: unknown, def: boolean): boolean { return typeof v === "boolean" ? v : def; }

// ── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "Claude Memory + Code RAG", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const a = (request.params.arguments ?? {}) as Record<string, unknown>;

  let text: string;

  if (name === "remember") {
    text = await rememberTool({
      content:     str(a["content"]),
      memory_type: str(a["memory_type"], "semantic"),
      scope:       str(a["scope"],       "project"),
      tags:        str(a["tags"],        ""),
      importance:  num(a["importance"],  0.5),
      ttl_hours:   int(a["ttl_hours"],   0),
    });
  } else if (name === "recall") {
    text = await recallTool({
      query:         str(a["query"]),
      memory_type:   str(a["memory_type"],   ""),
      scope:         str(a["scope"],         ""),
      tags:          str(a["tags"],          ""),
      limit:         int(a["limit"],         5),
      min_relevance: num(a["min_relevance"], 0.3),
      time_decay:    bool(a["time_decay"],   true),
      llm_filter:    bool(a["llm_filter"],   true),
    });
  } else if (name === "search_code") {
    text = await searchCodeTool({
      query:      str(a["query"]),
      file_path:  str(a["file_path"],  ""),
      chunk_type: str(a["chunk_type"], ""),
      limit:      int(a["limit"],      10),
    });
  } else if (name === "forget") {
    text = await forgetTool({ memory_id: str(a["memory_id"]) });
  } else if (name === "consolidate") {
    text = await consolidateTool({
      source:               str(a["source"],               "episodic"),
      target:               str(a["target"],               "semantic"),
      similarity_threshold: num(a["similarity_threshold"], 0.85),
      dry_run:              bool(a["dry_run"],              true),
    });
  } else if (name === "stats") {
    text = await statsTool();
  } else {
    text = `unknown tool: ${name}`;
  }

  return { content: [{ type: "text" as const, text }] };
});

// ── Startup ──────────────────────────────────────────────────────────────────

await ensureCollections();
process.stderr.write("[memory] MCP server ready\n");

const transport = new StdioServerTransport();
await server.connect(transport);
