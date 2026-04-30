import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";
import { getCurrentBranch } from "../indexer/git.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { cfg } from "../config.js";
import { getProjectId as getProjectIdCtx, requestContext } from "../request-context.js";
import { qd, colName } from "../qdrant.js";
import type { ProjectConfig } from "../server-config.js";

const _dir = dirname(fileURLToPath(import.meta.url));
const _uiDir = resolve(_dir, "../../dist/dashboard-ui");

const PKG_VERSION = (
  JSON.parse(readFileSync(resolve(_dir, "../../package.json"), "utf8")) as { version: string }
).version;

// ── Types ─────────────────────────────────────────────────────────────────────

interface ToolStats {
  calls:     number;
  bytesIn:   number;
  bytesOut:  number;
  totalMs:   number;
  errors:    number;
}

interface RequestEntry {
  ts:       number;
  tool:     string;
  source:   "mcp" | "playground" | "watcher" | "hook";
  projectId: string;
  bytesIn:  number;
  bytesOut: number;
  ms:       number;
  ok:       boolean;
  chunks?:  number;
  file?:    string;
  error?:   string;
}

type DispatchFn = (tool: string, args: Record<string, unknown>) => Promise<string>;

// ── Global state ──────────────────────────────────────────────────────────────

const toolStats  = new Map<string, ToolStats>();
const requestLog: RequestEntry[] = [];
const LOG_MAX    = 500;

const sseClients = new Set<ServerResponse>();

/** Last MCP initialize handshake per project (agent connected). */
const lastAgentConnect = new Map<string, { ts: number }>();

let _dispatch: DispatchFn | null = null;
let _toolSchemasJson = "[]";
let _active = false;

let _reindexProgress: { done: number; total: number; chunks: number } | null = null;
let _reindexTimer: ReturnType<typeof setTimeout> | null = null;
let _reindexLastSent = 0;

// ── Statistics helpers ────────────────────────────────────────────────────────

export function record(
  tool:     string,
  source:   "mcp" | "playground" | "hook",
  bytesIn:  number,
  bytesOut: number,
  ms:       number,
  ok:       boolean,
  error?:   string,
): void {
  if (!_active) return;
  const entry: RequestEntry = {
    ts: Date.now(),
    tool,
    source,
    projectId: getProjectIdCtx(),
    bytesIn,
    bytesOut,
    ms,
    ok,
    error,
  };
  updateStats(entry);
  requestLog.push(entry);
  if (requestLog.length > LOG_MAX) requestLog.shift();

  // SSE broadcast
  const data = `data: ${JSON.stringify({ type: "entry", entry, stats: statsSnapshot(), memory: memStats() })}\n\n`;
  for (const res of new Set(sseClients)) res.write(data);
}

/**
 * Called when an MCP client completes the initialize handshake.
 * Updates the per-project agent connection tracker and broadcasts via SSE.
 */
export function recordAgentConnect(projectId: string): void {
  if (!_active) return;
  const ts = Date.now();
  lastAgentConnect.set(projectId, { ts });
  const data = `data: ${JSON.stringify({ type: "agent-connect", projectId, ts })}\n\n`;
  for (const res of new Set(sseClients)) res.write(data);
}

/**
 * Called when an agent session ends (SessionEnd hook).
 * Removes the per-project agent connection entry and broadcasts via SSE.
 */
export function recordAgentDisconnect(projectId: string): void {
  if (!_active) return;
  lastAgentConnect.delete(projectId);
  const data = `data: ${JSON.stringify({ type: "agent-disconnect", projectId })}\n\n`;
  for (const res of new Set(sseClients)) res.write(data);
}

export function recordIndex(projectId: string, relPath: string, chunks: number, ms: number, ok: boolean, error?: string): void {
  if (!_active) return;
  const entry: RequestEntry = { ts: Date.now(), tool: "indexer", file: relPath, source: "watcher", projectId, bytesIn: 0, bytesOut: 0, ms, ok, chunks, error };
  updateStats(entry);
  requestLog.push(entry);
  if (requestLog.length > LOG_MAX) requestLog.shift();

  // SSE broadcast
  const data = `data: ${JSON.stringify({ type: "entry", entry, stats: statsSnapshot(), memory: memStats() })}\n\n`;
  for (const res of new Set(sseClients)) res.write(data);
}

async function serverInfo(): Promise<ServerInfo> {
  const projectId = getProjectIdCtx();
  const { loadProjectConfig } = await import("../server-config.js");
  const project = await loadProjectConfig(qd, projectId);
  const root = project?.project_dir || cfg.projectDir;

  return {
    projectId,
    version:              PKG_VERSION,
    branch:               getCurrentBranch(root),
    collectionPrefix:     cfg.collectionPrefix,
    embedProvider:        cfg.embedProvider,
    embedModel:           cfg.embedModel,
    llmProvider:          cfg.llmProvider,
    llmModel:             cfg.llmModel,
    generateDescriptions: cfg.generateDescriptions,
  };
}

interface ServerInfo {
  projectId:            string;
  version:              string;
  branch:               string;
  collectionPrefix:     string;
  embedProvider:        string;
  embedModel:           string;
  llmProvider:          string;
  llmModel:             string;
  generateDescriptions: boolean;
}

function statsSnapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [tool, s] of toolStats) {
    out[tool] = {
      ...s,
      avgMs:     s.calls > 0 ? s.totalMs / s.calls : 0,
      tokensEst: Math.round((s.bytesIn + s.bytesOut) / 4),
    };
  }
  return out;
}

function memStats(): Record<string, number> {
  return {};
}

function updateStats(entry: RequestEntry): void {
  const toolName = entry.source === "watcher" ? "indexer" : entry.tool;
  const prev = toolStats.get(toolName) ?? { calls: 0, bytesIn: 0, bytesOut: 0, totalMs: 0, errors: 0 };
  toolStats.set(toolName, {
    calls:    prev.calls    + 1,
    bytesIn:  prev.bytesIn  + entry.bytesIn,
    bytesOut: prev.bytesOut + entry.bytesOut,
    totalMs:  prev.totalMs  + entry.ms,
    errors:   prev.errors   + (entry.ok ? 0 : 1),
  });
}

export function broadcastShutdown(): void {
  const data = "data: {\"type\":\"shutdown\"}\n\n";
  for (const res of new Set(sseClients)) {
    res.write(data);
    res.end();
  }
  sseClients.clear();
}

export function broadcastMemoryUpdate(): void {
  if (!_active) return;
  const data = `data: ${JSON.stringify({ type: "memory_update" })}\n\n`;
  for (const res of new Set(sseClients)) res.write(data);
}

export function broadcastBranchSwitch(branch: string): void {
  if (!_active) return;
  const data = `data: ${JSON.stringify({ type: "branch", branch })}\n\n`;
  for (const res of new Set(sseClients)) res.write(data);
}

export function broadcastError(err: unknown): void {
  if (!_active) return;
  const message = err instanceof Error ? err.message : String(err);
  const stack   = err instanceof Error ? (err.stack ?? "") : "";
  const data    = `data: ${JSON.stringify({ type: "error", error: { message, stack, ts: Date.now() } })}\n\n`;
  for (const res of new Set(sseClients)) res.write(data);
}

// ── Memory API helpers ────────────────────────────────────────────────────────

interface MemoryEntry {
  id:           string;
  text:         string;
  status:       string;
  confidence:   number;
  session_id:   string;
  session_type: string;
  updated_at:   string;
  created_at:   string;
}

async function scrollMemoryEntries(projectId?: string): Promise<MemoryEntry[]> {
  const collections = [
    colName("memory"),
    colName("memory_agents"),
    colName("memory_episodic"),
    colName("memory_semantic"),
    colName("memory_procedural"),
  ];
  const allEntries: MemoryEntry[] = [];
  const seenHashes = new Set<string>();

  for (const col of collections) {
    let offset: string | number | undefined;
    while (true) {
      const result = await qd.scroll(col, {
        filter:       projectId ? { must: [{ key: "project_id", match: { value: projectId } }] } : undefined,
        limit:        500,
        with_payload: true,
        with_vector:  false,
        ...(offset !== undefined && { offset }),
      }).catch(() => ({ points: [] as any[], next_page_offset: null }));

      for (const pt of result.points) {
        const p    = (pt.payload ?? {}) as Record<string, unknown>;
        const text = String(p["text"] ?? p["content"] ?? "");
        const hash = String(p["content_hash"] ?? pt.id);
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);
        allEntries.push({
          id:           String(pt.id),
          text,
          status:       String(p["status"] ?? "resolved"),
          confidence:   Number(p["confidence"] ?? p["importance"] ?? 0),
          session_id:   String(p["session_id"] ?? ""),
          session_type: String(p["session_type"] ?? ""),
          updated_at:   String(p["updated_at"] ?? ""),
          created_at:   String(p["created_at"] ?? ""),
        });
      }

      const next = result.next_page_offset;
      if (!next || typeof next === "object") break;
      offset = next;
    }
  }

  return allEntries;
}

// ── Reindex progress helpers ──────────────────────────────────────────────────

function _broadcastReindex(): void {
  if (!_active || !_reindexProgress) return;
  _reindexLastSent = Date.now();
  const data = `data: ${JSON.stringify({ type: "reindex", progress: { ..._reindexProgress } })}\n\n`;
  for (const res of new Set(sseClients)) res.write(data);
}

export function startReindex(total: number): void {
  _reindexProgress = { done: 0, total, chunks: 0 };
  _reindexLastSent = Date.now();
  _broadcastReindex();
}

export function tickReindex(done: number, chunks: number): void {
  if (!_reindexProgress) return;
  _reindexProgress.done = done;
  _reindexProgress.chunks = chunks;
  
  const now = Date.now();
  if (now - _reindexLastSent > 1_000) {
    _broadcastReindex();
  } else if (!_reindexTimer) {
    const elapsed = now - _reindexLastSent;
    _reindexTimer = setTimeout(() => {
      _reindexTimer = null;
      _broadcastReindex();
    }, 1_000 - elapsed);
  }
}

export function endReindex(): void {
  if (!_reindexProgress) return;
  if (_reindexTimer) { clearTimeout(_reindexTimer); _reindexTimer = null; }
  _reindexProgress.done = _reindexProgress.total;
  _broadcastReindex();
  _reindexProgress = null;
}

export async function initDashboardState(toolSchemas: any[], dispatch: DispatchFn): Promise<void> {
  _active = true;
  _dispatch = dispatch;
  _toolSchemasJson = JSON.stringify(toolSchemas);

  try {
    const col = colName("request_logs");
    const result = await qd.scroll(col, {
      limit: 1000,
      with_payload: true,
      with_vector: false,
    });
    
    const entries = result.points
      .map(p => p.payload as unknown as RequestEntry)
      .filter(e => e && typeof e.ts === "number")
      .sort((a, b) => a.ts - b.ts);

    for (const entry of entries) {
      updateStats(entry);
      requestLog.push(entry);
      if (requestLog.length > LOG_MAX) requestLog.shift();
    }
    process.stderr.write(`[dashboard] loaded ${entries.length} historical records from Qdrant\n`);
  } catch (err: unknown) {
    process.stderr.write(`[dashboard] failed to load history: ${String(err)}\n`);
  }

  process.on("SIGINT",  () => { broadcastShutdown(); process.exit(0); });
  process.on("SIGTERM", () => { broadcastShutdown(); process.exit(0); });
}

// ── Fastify plugin ────────────────────────────────────────────────────────────

export async function dashboardPlugin(fastify: FastifyInstance): Promise<void> {
  await fastify.register(fastifyStatic, {
    root: _uiDir,
    prefix: "/",
    wildcard: false,
    index: false,
  });

  fastify.get("/", async (req, reply) => {
    const q         = req.query as Record<string, string>;
    const projectId = q["project"] || "default";

    return requestContext.run({ projectId }, async () => {
      const html   = readFileSync(resolve(_uiDir, "index.html"), "utf8");
      const { listProjectConfigs } = await import("../server-config.js");
      const projects = await listProjectConfigs(qd);

      const init   = JSON.stringify({
        stats:           statsSnapshot(),
        log:             requestLog,
        schemas:         JSON.parse(_toolSchemasJson) as unknown[],
        serverInfo:      await serverInfo(),
        memory:          memStats(),
        projects,
        agentConnections: Object.fromEntries(lastAgentConnect),
      });
      const inject = `<script>window.__INIT__=${init}</script>`;
      const out    = html.replace("</head>", `${inject}\n</head>`);
      return reply.header("Content-Type", "text/html; charset=utf-8").send(out);
    });
  });

  fastify.get("/events", async (req, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    raw.write("\n");

    const q = req.query as Record<string, string>;
    const projectId = q["project"] || "default";

    return requestContext.run({ projectId }, async () => {
      const { listProjectConfigs } = await import("../server-config.js");
      const projects = await listProjectConfigs(qd);
      const data = `data: ${JSON.stringify({ type: "init", stats: statsSnapshot(), log: requestLog, serverInfo: await serverInfo(), memory: memStats(), projects, agentConnections: Object.fromEntries(lastAgentConnect) })}\n\n`;
      raw.write(data);
      sseClients.add(raw);
      req.raw.on("close", () => { sseClients.delete(raw); });
    });
  });

  fastify.get<{ Querystring: { project_id?: string } }>("/api/memory/overview", async (req) => {
    const entries = await scrollMemoryEntries(req.query.project_id);

    const statusCounts: Record<string, number> = {
      in_progress: 0, resolved: 0, open_question: 0, hypothesis: 0, observation: 0,
    };
    for (const e of entries) {
      if (e.status in statusCounts) statusCounts[e.status]!++;
    }

    const recent = [...entries]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 10);

    const sessionMap = new Map<string, { count: number; types: Map<string, number>; latest: string }>();
    for (const e of entries) {
      if (!e.session_id) continue;
      const s = sessionMap.get(e.session_id) ?? { count: 0, types: new Map<string, number>(), latest: "" };
      s.count++;
      s.types.set(e.session_type, (s.types.get(e.session_type) ?? 0) + 1);
      if (e.updated_at > s.latest) s.latest = e.updated_at;
      sessionMap.set(e.session_id, s);
    }

    const sessions = [...sessionMap.entries()]
      .map(([session_id, s]) => {
        let dominant_type = "";
        let maxCount = 0;
        for (const [t, c] of s.types) { if (c > maxCount) { maxCount = c; dominant_type = t; } }
        return { session_id, count: s.count, dominant_type, latest: s.latest };
      })
      .sort((a, b) => b.latest.localeCompare(a.latest));

    return { statusCounts, recent, sessions };
  });

  fastify.get<{ Querystring: { status?: string; project_id?: string } }>("/api/memory/by-status", async (req) => {
    const statuses = new Set((req.query.status ?? "").split(",").map(s => s.trim()).filter(Boolean));
    const entries  = await scrollMemoryEntries(req.query.project_id);
    const filtered = statuses.size > 0 ? entries.filter(e => statuses.has(e.status)) : entries;
    return {
      entries: filtered
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 100),
    };
  });

  fastify.get<{ Querystring: { q?: string; project_id?: string } }>("/api/memory/search", async (req) => {
    const q = (req.query.q ?? "").trim();
    if (!q) return { systemMessage: "", results: [] };

    const projectId = req.query.project_id || "default";

    const { runArchivist }   = await import("../archivist.js");

    return requestContext.run({ projectId }, async () => {
      const systemMessage = await runArchivist(q);
      const { embedOne } = await import("../embedder.js");
      const embedding = await embedOne(q);

      const memCols = [colName("memory"), colName("memory_agents"), colName("memory_episodic"), colName("memory_semantic"), colName("memory_procedural")];
      const memHits = await Promise.all(memCols.map(col => 
        qd.search(col, { 
          vector: embedding, 
          filter: { must: [{ key: "project_id", match: { value: projectId } }] },
          limit: 10,
          with_payload: true
        }).catch(() => [])
      )).then(results => results.flat());

      const agentHits = await qd.search(colName("memory_agents"), {
        vector: embedding,
        filter: { must: [{ key: "project_id", match: { value: projectId } }] },
        limit: 10,
        with_payload: true
      }).catch(() => []);

      const seen: Set<string> = new Set();
      const results: any[] = [];
      for (const hit of [...memHits, ...agentHits]) {
        const p    = (hit.payload ?? {}) as Record<string, unknown>;
        const hash = String(p["content_hash"] ?? hit.id);
        if (seen.has(hash)) continue;
        seen.add(hash);
        results.push({
          id:           String(hit.id),
          text:         String(p["text"] ?? p["content"] ?? ""),
          status:       String(p["status"] ?? "resolved"),
          confidence:   Number(p["confidence"] ?? p["importance"] ?? 0),
          score:        hit.score,
          session_id:   String(p["session_id"] ?? ""),
          session_type: String(p["session_type"] ?? ""),
          updated_at:   String(p["updated_at"] ?? ""),
          created_at:   String(p["created_at"] ?? ""),
        });
      }
      results.sort((a, b) => b.score - a.score);
      return { systemMessage, results: results.slice(0, 5) };
    });
  });

  fastify.get("/api/config/server", async () => {
    const { loadServerConfig } = await import("../server-config.js");
    return loadServerConfig(qd);
  });

  fastify.put<{ Body: Partial<import("../server-config.js").ServerConfig> }>("/api/config/server", async (req, reply) => {
    const { loadServerConfig, saveServerConfig, mergeServerConfig } = await import("../server-config.js");
    const { applyServerConfig } = await import("../config.js");
    const current = await loadServerConfig(qd);
    const updated = mergeServerConfig({ ...current, ...req.body, embed: { ...current.embed, ...(req.body.embed ?? {}) }, llm: { ...current.llm, ...(req.body.llm ?? {}) }, router: { ...current.router, ...(req.body.router ?? {}) } });
    await saveServerConfig(qd, updated);
    applyServerConfig(updated);
    return reply.send({ ok: true });
  });

  fastify.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (req, reply) => {
    const { loadProjectConfig } = await import("../server-config.js");
    const project = await loadProjectConfig(qd, req.params.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    return project;
  });

  fastify.put<{ Params: { projectId: string }; Body: Partial<ProjectConfig> }>("/api/projects/:projectId", async (req, reply) => {
    const { mergeProjectConfig, upsertProjectConfig } = await import("../server-config.js");
    const { IndexerManager } = await import("../indexer/manager.js");
    const { readLocalConfig, defaultLocalConfigPath } = await import("../local-config.js");
    const updated = mergeProjectConfig({ ...req.body, project_id: req.params.projectId });
    await upsertProjectConfig(qd, updated);
    const localConfig = await readLocalConfig(defaultLocalConfigPath());
    await IndexerManager.syncProject(updated, localConfig);
    return reply.send({ ok: true });
  });

  fastify.get("/api/projects", async () => {
    const { listProjectConfigs } = await import("../server-config.js");
    return listProjectConfigs(qd);
  });

  fastify.post<{ Body: Partial<ProjectConfig> & { project_id: string } }>("/api/projects", async (req, reply) => {
    const body = req.body;
    if (!body.project_id) return reply.code(400).send({ error: "Missing project_id" });
    const { loadProjectConfig, mergeProjectConfig, upsertProjectConfig } = await import("../server-config.js");
    const { IndexerManager } = await import("../indexer/manager.js");
    const { readLocalConfig, defaultLocalConfigPath } = await import("../local-config.js");

    const existing = await loadProjectConfig(qd, body.project_id);
    const updated = mergeProjectConfig({ ...(existing ?? {}), ...body });
    await upsertProjectConfig(qd, updated);
    const localConfig = await readLocalConfig(defaultLocalConfigPath());
    await IndexerManager.syncProject(updated, localConfig);
    return reply.code(201).send({ ok: true });
  });

  fastify.post<{ Body: { tool: string; args: Record<string, unknown>; project_id?: string } }>("/api/run", (req, reply) => {
    if (!_dispatch) return reply.code(503).send({ error: "Dashboard not initialized" });
    const { tool, args, project_id } = req.body;
    const projectId = project_id || "default";

    return requestContext.run({ projectId }, async () => {
      const t0 = Date.now();
      try {
        const result = await _dispatch!(tool, args);
        const ms = Date.now() - t0;
        record(tool, "playground", JSON.stringify(args).length, result.length, ms, true);
        return reply.send({ ok: true, result, ms });
      } catch (err: unknown) {
        const ms = Date.now() - t0;
        record(tool, "playground", JSON.stringify(args).length, 0, ms, false, String(err));
        return reply.code(500).send({ error: String(err) });
      }
    });
  });

  fastify.get("/api/init", async (req) => {
    const q         = req.query as Record<string, string>;
    const projectId = q["project"] || "default";

    return requestContext.run({ projectId }, async () => {
      const { listProjectConfigs } = await import("../server-config.js");
      const projects = await listProjectConfigs(qd);
      return {
        stats:            statsSnapshot(),
        log:              requestLog,
        schemas:          JSON.parse(_toolSchemasJson) as unknown[],
        serverInfo:       await serverInfo(),
        memory:           memStats(),
        projects,
        agentConnections: Object.fromEntries(lastAgentConnect),
      };
    });
  });
}

export async function startDashboard(fastify: FastifyInstance, toolSchemas: any[], dispatch: DispatchFn): Promise<void> {
  await initDashboardState(toolSchemas, dispatch);
  await dashboardPlugin(fastify);
}
