import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Server }                         from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport }  from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError }
  from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, TOOL_MAP, dispatchTool }  from "../tools/registry.js";
import { requestContext }                 from "../request-context.js";
import { record, recordAgentConnect }      from "./dashboard.js";
import { debugLog }                       from "../util.js";
import { basename }                       from "node:path";
import { findProjectByDir, upsertProjectConfig, mergeProjectConfig } from "../server-config.js";
import { resolveWorktreeMainRoot }        from "../indexer/git.js";
import { qd }                             from "../qdrant.js";

// Server instructions are delivered once in the MCP `initialize` handshake
// and injected by clients (Claude Code, VSCode Copilot, Goose, Zed...) directly
// into the system prompt. This is the correct channel for static setup guidance —
// it beats SessionStart hooks on salience, persists across /compact, and works
// before any user turn. Keep under 2048 chars (Claude Code truncates at 2KB).
// Put the most important guidance near the top; weaker models only read the start.
const SERVER_INSTRUCTIONS = `
You have access to a persistent memory + code-RAG server for this project.
Treat it as your long-term memory: prior decisions, bug fixes, open questions,
and a semantic index of the codebase all live here. You have continuity across
sessions only through these tools.

Core workflow for any non-trivial task:

  1. recall(query)        — before starting. Past decisions, resolved bugs,
                            open_questions, work in progress. Skip only for
                            trivial edits or pure syntax questions.
  2. search_code(query)   — locate code by meaning, not by filename. Use when
                            you don't know where something lives. Returns
                            symbols with file paths and content chunks.
  3. [think + act]
  4. remember(content, memory_type, importance)
                          — the moment you learn something: a bug's root cause,
                            a non-obvious pattern, a command that works, an API
                            constraint. One fact per call. Without this,
                            knowledge is lost at session end.

Memory types: "episodic" (events, bugs), "semantic" (facts, architecture),
"procedural" (patterns, conventions). Status on recall results —
"open_question", "in_progress", "hypothesis", "resolved" — is a priority
signal: treat open_question and in_progress as active agenda.

Anti-patterns: batching remember() at session end (knowledge decays),
skipping recall() because "I know this codebase" (you don't remember past
sessions), ignoring search_code in favour of Read/grep on unfamiliar repos.
`.trim();

function buildMcpServer(projectId: string): Server {
  const server = new Server(
    { name: "local-rag", version: "2.0.0" },
    {
      capabilities:  { tools: {}, resources: {}, prompts: {}, logging: {} },
      instructions: SERVER_INSTRUCTIONS,
    }
  );


  // Fire when the MCP initialize handshake completes — agent is now connected.
  server.oninitialized = () => { recordAgentConnect(projectId); };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const a        = (request.params.arguments ?? {}) as Record<string, unknown>;
    const bytesIn  = JSON.stringify(a).length;
    const t0       = Date.now();

    debugLog("mcp", `tool=${name}`);

    const tool = TOOL_MAP.get(name);
    if (!tool) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);

    const required = (tool.inputSchema.required ?? []) as string[];
    const missing  = required.filter(k => !(k in a));
    if (missing.length > 0)
      throw new McpError(ErrorCode.InvalidParams, `Missing required argument(s): ${missing.join(", ")}`);

    try {
      const text    = await dispatchTool(name, a);
      const elapsed = Date.now() - t0;
      record(name, "mcp", bytesIn, text.length, elapsed, true);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const elapsed = Date.now() - t0;
      const errStr  = err instanceof Error ? err.message : String(err);
      record(name, "mcp", bytesIn, 0, elapsed, false, errStr);
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, errStr);
    }
  });

  return server;
}

async function handleMcpRequest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const q          = req.query as Record<string, string>;
  const rawDir     = (req.headers["x-project-dir"] as string | undefined) ?? q["project_dir"];
  const projectDir = rawDir ? decodeURIComponent(rawDir) : undefined;
  let   projectId  = q["project"] ?? "default";

  if (projectDir) {
    const canonicalDir = resolveWorktreeMainRoot(projectDir) ?? projectDir;
    let project = await findProjectByDir(qd, canonicalDir);
    if (!project) {
      project = mergeProjectConfig({ project_id: basename(canonicalDir), project_dir: canonicalDir });
      await upsertProjectConfig(qd, project);
    }
    projectId = project.project_id;
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const mcpServer = buildMcpServer(projectId);
  await mcpServer.connect(transport);

  await requestContext.run({ projectId, projectDir }, async () => {
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  await mcpServer.close();
}

export async function mcpPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.addContentTypeParser("application/json", { parseAs: "string" },
    (_req, body, done) => {
      try { done(null, JSON.parse(body as string)); }
      catch (e) { done(e as Error); }
    }
  );

  fastify.post("/mcp",    handleMcpRequest);
  fastify.get("/mcp",     handleMcpRequest);
  fastify.delete("/mcp",  handleMcpRequest);
}
