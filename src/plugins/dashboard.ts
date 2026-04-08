import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { getCurrentBranch } from "../indexer/git.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cfg } from "../config.js";
import { qd, colName } from "../qdrant.js";
import { embedOne } from "../embedder.js";
import { getProjectId, getAgentId, runWithContext, requestContext } from "../request-context.js";

const _dir   = dirname(fileURLToPath(import.meta.url));
const _uiDir = resolve(_dir, "../dashboard-ui");

const PKG_VERSION: string = (
  JSON.parse(readFileSync(resolve(_dir, "../../package.json"), "utf8")) as { version: string }
).version;

// ── Types ─────────────────────────────────────────────────────────────────────

interface ToolStats {
  calls:    number;
  bytesIn:  number;
  bytesOut: number;
  totalMs:  number;
  errors:   number;
}

interface RequestEntry {
  ts:       number;
  tool:     string;
  source:   "mcp" | "playground" | "watcher" | "hook";
  projectId: string;
  agentId:   string;
  bytesIn:  number;
  bytesOut: number;
  ms:       number;
  ok:       boolean;
  chunks?:  number;
  file?:    string;
  error?:   string;
}

type DispatchFn = (tool: string, args: Record<string, unknown>) => Promise<string>;

interface ToolSchemaDef {
  name: string;
  inputSchema: { properties: Record<string, unknown>; required: string[] };
}

interface ServerInfo {
  projectId:            string;
  agentId:              string;
  version:              string;
  branch:               string;
  collectionPrefix:     string;
  embedProvider:        string;
  embedModel:           string;
  llmProvider:          string;
  llmModel:             string;
  generateDescriptions: boolean;
}

// ── Module-level state ────────────────────────────────────────────────────────

let _dispatch: DispatchFn | null = null;
let _toolSchemasJson = "[]";
let _active = false;

// ── In-memory state ───────────────────────────────────────────────────────────

const toolStats  = new Map<string, ToolStats>();
const LOG_MAX    = 500;
const requestLog: RequestEntry[] = [];
const sseClients = new Set<ServerResponse>();

// ── Watcher SSE throttle ──────────────────────────────────────────────────────
let _watcherFlushTimer: ReturnType<typeof setTimeout> | null = null;
let _watcherLastSse = 0;

// ── Reindex progress ──────────────────────────────────────────────────────────
interface ReindexProgress { total: number; done: number; chunks: number; }
let _reindexProgress: ReindexProgress | null = null;
let _reindexTimer: ReturnType<typeof setTimeout> | null = null;
let _reindexLastSent = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function memStats(): { rss: number; heapUsed: number; heapTotal: number; external: number } {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external };
}

async function serverInfo(): Promise<ServerInfo> {
  const projectId = getProjectId();
  const { loadProjectConfig } = await import("../server-config.js");
  const project = await loadProjectConfig(qd, projectId);
  const root = project?.project_root || cfg.projectRoot;

  return {
    projectId,
    agentId:              getAgentId(),
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

async function persistEntry(entry: RequestEntry): Promise<void> {
  const col = colName("request_logs");
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  await qd.upsert(col, {
    points: [{
      id: crypto.randomUUID(),
      vector: [0],
      payload: { ...entry, expires_at: expiresAt },
    }],
  }).catch((err: unknown) => {
    process.stderr.write(`[dashboard] failed to persist log: ${String(err)}\n`);
  });
}

function updateStats(entry: RequestEntry): void {
  // Normalize tool name for indexer entries (group by tool, not by file path)
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

export function record(tool: string, source: "mcp" | "playground" | "hook", bytesIn: number, bytesOut: number, ms: number, ok: boolean, error?: string): void {
  const projectId = getProjectId();
  const agentId   = getAgentId();

  const entry: RequestEntry = { ts: Date.now(), tool, source, projectId, agentId, bytesIn, bytesOut, ms, ok, ...(error ? { error } : {}) };
  updateStats(entry);
  requestLog.push(entry);
  if (requestLog.length > LOG_MAX) requestLog.shift();

  const data = `data: ${JSON.stringify({ type: "entry", entry, stats: statsSnapshot(), memory: memStats() })}\n\n`;
  for (const res of new Set(sseClients)) res.write(data);

  persistEntry(entry).catch(() => undefined);
}

export function recordIndex(projectId: string, relPath: string, chunks: number, ms: number, ok: boolean): void {
  if (!_active) return;
  const entry: RequestEntry = { ts: Date.now(), tool: "indexer", file: relPath, source: "watcher", projectId, agentId: "indexer", bytesIn: 0, bytesOut: 0, ms, ok, chunks };
  updateStats(entry);
  requestLog.push(entry);
  if (requestLog.length > LOG_MAX) requestLog.shift();

  // Throttle SSE writes to at most once per second
  const elapsed = Date.now() - _watcherLastSse;
  if (elapsed >= 1_000) {
    if (_watcherFlushTimer) { clearTimeout(_watcherFlushTimer); _watcherFlushTimer = null; }
    _watcherLastSse = Date.now();
    const data = `data: ${JSON.stringify({ type: "entry", entry, stats: statsSnapshot(), memory: memStats() })}\n\n`;
    for (const res of new Set(sseClients)) res.write(data);
  } else if (!_watcherFlushTimer) {
    _watcherFlushTimer = setTimeout(() => {
      _watcherFlushTimer = null;
      _watcherLastSse = Date.now();
      const last = requestLog[requestLog.length - 1];
      if (last?.source === "watcher") {
        const data = `data: ${JSON.stringify({ type: "entry", entry: last, stats: statsSnapshot(), memory: memStats() })}\n\n`;
        for (const res of new Set(sseClients)) res.write(data);
      }
    }, 1_000 - elapsed);
  }

  persistEntry(entry).catch(() => undefined);
}

function openBrowser(url: string): void {
  const [cmd, ...args] =
    process.platform === "darwin" ? ["open", url] :
    process.platform === "win32"  ? ["cmd", "/c", "start", "", url] :
                                    ["xdg-open", url];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

export function broadcastShutdown(): void {
  const data = `data: ${JSON.stringify({ type: "shutdown" })}\n\n`;
  for (const res of new Set(sseClients)) res.write(data);
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
  const message = err instanceof Error ? err.message : String(err);
  const stack   = err instanceof Error ? (err.stack ?? "") : "";
  const data = `data: ${JSON.stringify({ type: "error", message, stack, ts: Date.now() })}\n\n`;
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
      }).catch(() => ({ points: [] as { id: string | number; payload?: Record<string, unknown> | null }[], next_page_offset: null as null | string | number }));

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

      const next = (result as { next_page_offset?: string | number | null }).next_page_offset;
      if (!next) break;
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
  if (_reindexTimer) { clearTimeout(_reindexTimer); _reindexTimer = null; }
  _reindexProgress = { total, done: 0, chunks: 0 };
  _reindexLastSent = 0;
  _broadcastReindex();
}

export function tickReindex(chunks: number): void {
  if (!_active || !_reindexProgress) return;
  _reindexProgress.done++;
  _reindexProgress.chunks += chunks;
  const elapsed = Date.now() - _reindexLastSent;
  if (elapsed >= 1_000) {
    if (_reindexTimer) { clearTimeout(_reindexTimer); _reindexTimer = null; }
    _broadcastReindex();
  } else if (!_reindexTimer) {
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

export async function initDashboardState(toolSchemas: ToolSchemaDef[], dispatch: DispatchFn): Promise<void> {
  _active = true;
  _dispatch = dispatch;
  _toolSchemasJson = JSON.stringify(toolSchemas);

  // Load history from Qdrant
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
    root:  _uiDir,
    index: false,
  });

  fastify.get("/", async (req, reply) => {
    const q         = req.query as Record<string, string>;
    const projectId = q["project"] || "default";
    const agentId   = q["agent"]   || projectId;

    return requestContext.run({ projectId, agentId }, async () => {
      const html   = readFileSync(resolve(_uiDir, "index.html"), "utf8");
      const { listProjectConfigs } = await import("../server-config.js");
      const projects = await listProjectConfigs(qd);

      const init   = JSON.stringify({
        stats:      statsSnapshot(),
        log:        requestLog,
        schemas:    JSON.parse(_toolSchemasJson) as unknown[],
        serverInfo: await serverInfo(),
        memory:     memStats(),
        projects,
      });
      const inject = `<script>window.__INIT__=${init}</script>`;
      const out    = html.replace("</head>", `${inject}\n</head>`);
      return reply.header("Content-Type", "text/html; charset=utf-8").send(out);
    });
  });

  fastify.get("/events", async (req, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.setHeader("Content-Type",  "text/event-stream");
    raw.setHeader("Cache-Control", "no-cache");
    raw.setHeader("Connection",    "keep-alive");
    raw.flushHeaders();

    const { listProjectConfigs } = await import("../server-config.js");
    const projects = await listProjectConfigs(qd);

    raw.write(`data: ${JSON.stringify({ type: "init", stats: statsSnapshot(), log: requestLog, reindex: _reindexProgress, memory: memStats(), projects })}\n\n`);
    sseClients.add(raw);
    req.raw.on("close", () => { sseClients.delete(raw); });
  });

  fastify.get("/api/stats", async (_req, _reply) => {
    return { stats: statsSnapshot(), memory: memStats() };
  });

  fastify.post<{ Body: { tool: string; args: Record<string, unknown>; project_id?: string; agent_id?: string } }>("/api/run", (req, reply) => {
    const t0      = Date.now();
    const { tool, args, project_id, agent_id } = req.body;
    const bytesIn = JSON.stringify(args ?? {}).length;

    const projectId = project_id || "default";
    const agentId   = agent_id   || "playground";

    void runWithContext({ projectId, agentId }, async () => {
      try {
        const result = await _dispatch!(tool, args ?? {});
        const ms = Date.now() - t0;
        record(tool, "playground", bytesIn, result.length, ms, true);
        void reply.send({ ok: true, result, ms });
      } catch (err: unknown) {
        const ms     = Date.now() - t0;
        const errStr = err instanceof Error ? (err.stack ?? err.message) : String(err);
        record(tool, "playground", bytesIn, 0, ms, false, errStr);
        void reply.code(500).send({ ok: false, error: String(err), ms });
      }
    });
  });

  fastify.get<{ Querystring: { project_id?: string } }>("/api/memory/overview", async (req) => {
    const entries = await scrollMemoryEntries(req.query.project_id);

    const statusCounts: Record<string, number> = {
      in_progress: 0, resolved: 0, open_question: 0, hypothesis: 0,
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

  fastify.get<{ Querystring: { q?: string; project_id?: string; agent_id?: string } }>("/api/memory/search", async (req) => {
    const q = (req.query.q ?? "").trim();
    if (!q) return { systemMessage: "", results: [] };

    const projectId = req.query.project_id || "default";
    const agentId   = req.query.agent_id   || projectId;

    const { runWithContext } = await import("../request-context.js");
    const { runArchivist }   = await import("../archivist.js");

    return runWithContext({ projectId, agentId }, async () => {
      // 1. Run LLM-powered archivist (same as hook-recall)
      const systemMessage = await runArchivist(q);

      // 2. Also do raw vector search for the UI hits
      const vector    = await embedOne(q);
      const mustFilter: any[] = [{ key: "project_id", match: { value: projectId } }];

      type QHit = Awaited<ReturnType<typeof qd.search>>[number];
      const [memHits, agentHits] = await Promise.all([
        qd.search(colName("memory"), {
          vector, filter: { must: mustFilter }, limit: 10, with_payload: true, score_threshold: 0.5,
        }).catch((): QHit[] => []),
        qd.search(colName("memory_agents"), {
          vector, filter: { must: mustFilter }, limit: 10, with_payload: true, score_threshold: 0.5,
        }).catch((): QHit[] => []),
      ]);

      const seen: Set<string> = new Set();
      const results: Array<{ id: string; text: string; status: string; confidence: number; score: number; session_id: string; session_type: string; updated_at: string; created_at: string }> = [];
      for (const hit of [...memHits, ...agentHits]) {
        const p    = (hit.payload ?? {}) as Record<string, unknown>;
        const hash = String(p["content_hash"] ?? hit.id);
        if (seen.has(hash)) continue;
        seen.add(hash);
        results.push({
          id:           String(hit.id),
          text:         String(p["text"] ?? ""),
          status:       String(p["status"] ?? "resolved"),
          confidence:   Number(p["confidence"] ?? 0),
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

  fastify.post("/api/projects", async (req, reply) => {
    const { upsertProjectConfig, mergeProjectConfig } = await import("../server-config.js");
    const { qd } = await import("../qdrant.js");
    const { IndexerManager } = await import("../indexer/manager.js");
    const body = req.body as Partial<import("../server-config.js").ProjectConfig> & { project_id: string };
    if (!body.project_id) return reply.code(400).send({ error: "Missing project_id" });
    const updated = mergeProjectConfig(body);
    await upsertProjectConfig(qd, updated);
    const { readLocalConfig, defaultLocalConfigPath } = await import("../local-config.js");
    const localConfig = await readLocalConfig(defaultLocalConfigPath());
    await IndexerManager.syncProject(updated, localConfig);
    return reply.code(201).send({ ok: true });
  });

  fastify.get("/api/projects", async (_req, reply) => {
    const { listProjectConfigs } = await import("../server-config.js");
    const { qd } = await import("../qdrant.js");
    const projects = await listProjectConfigs(qd);
    return reply.send({ projects });
  });

  // GET /api/config/server — return current server config
  fastify.get("/api/config/server", async () => {
    const { loadServerConfig } = await import("../server-config.js");
    const { qd } = await import("../qdrant.js");
    return loadServerConfig(qd);
  });

  // PUT /api/config/server — update server config
  fastify.put("/api/config/server", async (req, reply) => {
    const { loadServerConfig, saveServerConfig, mergeServerConfig } = await import("../server-config.js");
    const { applyServerConfig } = await import("../config.js");
    const { qd } = await import("../qdrant.js");
    const current = await loadServerConfig(qd);
    const body = req.body as Record<string, unknown>;
    const updated = mergeServerConfig({ ...current, ...body });
    await saveServerConfig(qd, updated);
    applyServerConfig(updated);
    return reply.send({ ok: true });
  });

  // GET /api/projects/:projectId
  fastify.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (req) => {
    const { loadProjectConfig } = await import("../server-config.js");
    const { qd } = await import("../qdrant.js");
    return loadProjectConfig(qd, req.params.projectId);
  });

  // PUT /api/projects/:projectId
  fastify.put<{ Params: { projectId: string } }>("/api/projects/:projectId", async (req, reply) => {
    const { loadProjectConfig, upsertProjectConfig, mergeProjectConfig } = await import("../server-config.js");
    const { qd } = await import("../qdrant.js");
    const { IndexerManager } = await import("../indexer/manager.js");
    const body = req.body as Record<string, unknown>;
    const current = await loadProjectConfig(qd, req.params.projectId) ?? mergeProjectConfig({ project_id: req.params.projectId });
    const updated = mergeProjectConfig({ ...current, ...body, project_id: req.params.projectId });
    await upsertProjectConfig(qd, updated);
    const { readLocalConfig, defaultLocalConfigPath } = await import("../local-config.js");
    const localConfig = await readLocalConfig(defaultLocalConfigPath());
    await IndexerManager.syncProject(updated, localConfig);
    return reply.send({ ok: true });
  });
}

// ── Legacy startDashboard (kept for backward compat during transition) ────────

export function startDashboard(port: number, toolSchemas: ToolSchemaDef[], dispatch: DispatchFn): void {
  initDashboardState(toolSchemas, dispatch);
  import("fastify").then(({ default: Fastify }) => {
    const app = Fastify({ logger: false });
    void dashboardPlugin(app).then(() => {
      app.listen({ port, host: "0.0.0.0" })
        .then(() => {
          const addr = app.server.address();
          const actualPort = typeof addr === "object" && addr ? addr.port : port;
          const url = `http://localhost:${actualPort}`;
          process.stderr.write(`[dashboard] ${url}\n`);
          openBrowser(url);
          app.server.unref();
        })
        .catch((err: unknown) => {
          process.stderr.write(`[dashboard] HTTP error: ${String(err)}\n`);
        });
    });
  }).catch((err: unknown) => {
    process.stderr.write(`[dashboard] import error: ${String(err)}\n`);
  });
}
