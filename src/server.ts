import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ensureCollections } from "./qdrant.js";
import { record, startDashboard } from "./dashboard.js";
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
    description: `Store a memory — fact, decision, bug, or pattern — for future retrieval by this or other agents on the same project.

WHEN TO USE: after finding a bug, making an architectural decision, discovering a codebase convention, or completing a significant edit. Call immediately when you learn something worth preserving.

DO NOT store: file contents, diffs, raw logs, or anything already in git. Use search_code for code — memory is for knowledge that isn't in source files.

memory_type:
  "episodic"   — events / bugs / what happened (subject to time-decay in recall)
  "semantic"   — facts / architecture / business logic (long-lived, default)
  "procedural" — how-to patterns / conventions / team rules (long-lived)

scope:
  "project" — shared with all agents on this project (default, use for most things)
  "global"  — shared across all projects (use for general patterns)
  "agent"   — private to this agent session only

importance 0.8+ = critical — will always surface in recall results.
Max ~2000 chars per entry (embedder truncates beyond that). Split large topics into multiple calls with different tags.

With Serena: call remember() after replace_symbol_body() or rename_symbol() to record why you made the change.`,
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
    description: `Semantic search across stored memories. Call BEFORE every action — before editing code, before debugging, before making architecture decisions.

Returns past decisions, known bugs, patterns, and facts relevant to your query. Does NOT search source code — use search_code for that.

WHEN TO USE ALONE: when you need to check past decisions or known issues before starting a task, with no immediate need to look at code.

WHEN TO USE WITH Serena (recommended two-step orientation):
  1. recall("task keywords")                  ← find past decisions and known patterns
  2. search_code("concept you're looking for") ← find current code
  3. find_symbol("SymbolName", body=True)      ← read precise symbol body (Serena)

llm_filter=true (default): LLM reranker removes false positives — more accurate, slightly slower.
time_decay=true (default): penalises old episodic memories — useful for "what happened recently".
Set time_decay=false for semantic/procedural queries about stable facts.`,
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
    description: `Semantic RAG search over the indexed codebase. Finds code by meaning, not just text matching. Returns snippets, file paths, line ranges, and symbol signatures.

WHEN TO USE ALONE: when you want to understand how something works in the codebase and don't need to edit — the results are readable on their own.

WHEN TO USE WITH Serena (the standard discovery → edit pipeline):
  1. search_code("user auth token validation")          ← DISCOVER: find file + symbol name
  2. find_symbol("validateToken", include_body=True)   ← READ: precise body via Serena
  3. get_dependencies("src/auth/token.ts", "imported_by") ← IMPACT: who depends on it
  4. find_referencing_symbols("validateToken", ...)    ← CALL SITES: via Serena
  5. replace_symbol_body("validateToken", ...)         ← EDIT: via Serena
  6. remember("changed validateToken because...")      ← PERSIST: record the decision

DO NOT use Serena's search_for_pattern as a substitute — it is regex-only and has no semantic understanding. Always use search_code first for discovery, then hand off exact names to Serena.

search_mode:
  "hybrid"   — RRF fusion of code + description vectors (default, best for most queries)
  "code"     — code vector only (structural / syntactic similarity)
  "semantic" — description vector only (conceptual search when you don't know the name)

chunk_type filter: "function" | "class" | "interface" | "type_alias" | "enum"
file_path filter: substring match on path, e.g. "src/auth" or "indexer.ts"`,
    inputSchema: {
      type: "object" as const,
      properties: {
        query:       { type: "string",  description: "Natural language description" },
        file_path:   { type: "string",  description: "File path substring filter",  default: "" },
        chunk_type:  { type: "string",  description: "function | class | interface | type_alias | enum", default: "" },
        limit:       { type: "integer", description: "Max results",                  default: 10 },
        search_mode: { type: "string",  description: "hybrid | code | semantic",     default: "hybrid" },
      },
      required: ["query"],
    },
  },
  {
    name: "forget",
    description: `Delete a memory permanently by its UUID.

WHEN TO USE: when a memory is factually wrong, superseded by a newer decision, or was stored in error. Cannot be undone.

Get the memory_id from recall() results (shown in each result entry).
Do not delete other agents' memories without a clear reason — prefer adding a clarifying remember() entry instead.`,
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
    description: `Merge semantically similar memories to reduce noise, contradiction, and duplication.

WHEN TO USE: after a large session with many remember() calls, or when recall() is returning redundant results. Run periodically as "memory hygiene".

ALWAYS run with dry_run=true first to preview what would be merged, then re-run with dry_run=false to execute.

similarity_threshold:
  0.95 — near-duplicates only (safe, conservative)
  0.85 — default, merges clearly related entries
  0.70 — aggressive, merges loosely related topics (use with care)

source/target: typically merge "episodic" → "semantic" to promote event memories into stable facts.`,
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
    description: `Return memory and codebase index statistics.

Reports: memory counts by type and scope, Qdrant collection sizes, number of indexed files and code chunks, and last-indexed timestamp.

WHEN TO USE:
  - Verify the codebase has been indexed before running search_code
  - Check how many memories exist to decide if consolidation is needed
  - Multi-agent coordination: compare counts to see if another agent stored relevant memories
  - Diagnose why search_code returns no results (index may be empty or stale)

No arguments required.`,
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_file_context",
    description: `Read a file or a window of lines centred on a symbol name or line range, using indexed metadata.

Returns: the requested source lines AND a list of all indexed symbols in the file with their line ranges — useful for understanding a file's full structure at a glance.

WHEN TO USE ALONE: when you need to see all symbols in a file alongside the source, or when reading by line range rather than symbol name.

WHEN TO USE WITH Serena:
  Prefer Serena's find_symbol(include_body=True) when you already know the exact symbol name — it is faster and more precise.
  Use get_file_context when you don't yet know which symbol to target, to get an index of all symbols first.

  Typical workflow:
    search_code("config validation")             ← find the file
    get_file_context("src/config.ts")            ← see all symbols + their line ranges
    find_symbol("validateConfig", body=True)     ← read the specific symbol (Serena)
    get_dependencies("src/config.ts", "imported_by") ← blast radius (this MCP)
    replace_symbol_body("validateConfig", ...)   ← edit (Serena)`,
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
    description: `Show import dependencies of a file: what it imports and/or what imports it. Reads from the import graph stored in the code index.

WHEN TO USE ALONE: to understand whether a file is safe to delete, or to trace where a module is consumed across the project.

WHEN TO USE WITH Serena — call BEFORE any edit to understand blast radius:
  search_code("payment processor logic")                        ← find the file
  get_dependencies("src/payments/processor.ts", "imported_by") ← who will break
  find_referencing_symbols("processPayment", ...)              ← exact call sites (Serena)
  replace_symbol_body("processPayment", ...)                   ← edit safely (Serena)
  remember("changed processPayment signature: added txId param") ← record it

direction:
  "imported_by" — files that depend on this file (most useful before edits — shows blast radius)
  "imports"     — files this file depends on (useful for understanding what it needs)
  "both"        — both directions (default)

depth: 1 = direct only; 2–3 = transitive; 4–5 = full graph (can be large on core modules).`,
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path:  { type: "string",  description: "Relative file path" },
        direction:  { type: "string",  description: "imports | imported_by | both", default: "both" },
        depth:      { type: "integer", description: "Traversal depth 1–5",          default: 1 },
      },
      required: ["file_path"],
    },
  },
  {
    name: "project_overview",
    description: `Return a high-level map of the project: 3-level directory tree, entry points, language distribution, indexed file count, and the top-10 most-imported modules.

WHEN TO USE: call FIRST when starting work on an unfamiliar codebase, before any search_code or Serena operations. Orients you to the structure so your subsequent searches and edits are well-targeted.

WHEN TO USE ALONE: sufficient on its own to answer "what does this project do?" and "where do I start?".

WHEN TO USE WITH Serena — the full recommended workflow for any non-trivial task:
  1. project_overview()                          ← orient: structure, entry points, hot modules
  2. recall("task keywords")                     ← memory: past decisions on this topic
  3. search_code("what you're looking for")      ← discover: find relevant files + symbol names
  4. get_file_context("src/found/file.ts")       ← survey: all symbols in the file
  5. find_symbol("TargetSymbol", body=True)      ← read: precise body (Serena)
  6. get_dependencies("src/found/file.ts", "imported_by") ← impact: blast radius
  7. find_referencing_symbols("TargetSymbol")    ← call sites (Serena)
  8. replace_symbol_body("TargetSymbol", ...)    ← edit (Serena)
  9. remember("what changed and why")            ← persist: record the decision

No arguments required.`,
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
  { name: "Claude Memory + Code RAG", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const a = (request.params.arguments ?? {}) as Record<string, unknown>;
  const bytesIn = JSON.stringify(a).length;
  const t0 = Date.now();

  const dispatch = async (): Promise<string> => {
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
        query:       str(a["query"]),
        file_path:   str(a["file_path"],   ""),
        chunk_type:  str(a["chunk_type"],  ""),
        limit:       int(a["limit"],       10),
        search_mode: str(a["search_mode"], "hybrid"),
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
    } else if (name === "get_file_context") {
      text = await getFileContextTool({
        file_path:     str(a["file_path"]),
        symbol_name:   str(a["symbol_name"],   ""),
        start_line:    int(a["start_line"],    0),
        end_line:      int(a["end_line"],      0),
        context_lines: int(a["context_lines"], 10),
      });
    } else if (name === "get_dependencies") {
      text = await getDependenciesTool({
        file_path: str(a["file_path"]),
        direction: str(a["direction"], "both"),
        depth:     int(a["depth"],     1),
      });
    } else if (name === "project_overview") {
      text = await projectOverviewTool();
    } else {
      text = `unknown tool: ${name}`;
    }

    return text;
  };

  let ok = false;
  return dispatch()
    .then((text) => {
      ok = true;
      record(name, bytesIn, text.length, Date.now() - t0, true);
      return { content: [{ type: "text" as const, text }] };
    })
    .finally(() => {
      if (!ok) record(name, bytesIn, 0, Date.now() - t0, false);
    });
});

// ── Startup ──────────────────────────────────────────────────────────────────

await ensureCollections();
if (cfg.dashboard) startDashboard(cfg.dashboardPort);
process.stderr.write("[memory] MCP server ready\n");

const transport = new StdioServerTransport();
await server.connect(transport);
