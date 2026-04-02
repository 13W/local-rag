import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import type { ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { getCurrentBranch } from "./indexer/git.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cfg } from "./config.js";

const _dir   = dirname(fileURLToPath(import.meta.url));
const _uiDir = resolve(_dir, "dashboard-ui");

const PKG_VERSION: string = (
  JSON.parse(readFileSync(resolve(_dir, "../package.json"), "utf8")) as { version: string }
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
  source:   "mcp" | "playground" | "watcher";
  bytesIn:  number;
  bytesOut: number;
  ms:       number;
  ok:       boolean;
  chunks?:  number;
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
  watch:                boolean;
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
let _serverInfo: ServerInfo | null = null;
let _serverInfoJson  = "{}";
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

export function record(tool: string, source: "mcp" | "playground", bytesIn: number, bytesOut: number, ms: number, ok: boolean, error?: string): void {
  const prev = toolStats.get(tool) ?? { calls: 0, bytesIn: 0, bytesOut: 0, totalMs: 0, errors: 0 };
  toolStats.set(tool, {
    calls:    prev.calls    + 1,
    bytesIn:  prev.bytesIn  + bytesIn,
    bytesOut: prev.bytesOut + bytesOut,
    totalMs:  prev.totalMs  + ms,
    errors:   prev.errors   + (ok ? 0 : 1),
  });

  const entry: RequestEntry = { ts: Date.now(), tool, source, bytesIn, bytesOut, ms, ok, ...(error ? { error } : {}) };
  requestLog.push(entry);
  if (requestLog.length > LOG_MAX) requestLog.shift();

  const data = `data: ${JSON.stringify({ type: "entry", entry, stats: statsSnapshot(), memory: memStats() })}\n\n`;
  for (const res of new Set(sseClients)) res.write(data);
}

export function recordIndex(relPath: string, chunks: number, ms: number, ok: boolean): void {
  if (!_active) return;
  const entry: RequestEntry = { ts: Date.now(), tool: relPath, source: "watcher", bytesIn: 0, bytesOut: 0, ms, ok, chunks };
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

export function broadcastBranchSwitch(branch: string): void {
  if (!_active || !_serverInfo) return;
  _serverInfo.branch = branch;
  _serverInfoJson = JSON.stringify(_serverInfo);
  const data = `data: ${JSON.stringify({ type: "branch", branch })}\n\n`;
  for (const res of new Set(sseClients)) res.write(data);
}

export function broadcastError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack   = err instanceof Error ? (err.stack ?? "") : "";
  const data = `data: ${JSON.stringify({ type: "error", message, stack, ts: Date.now() })}\n\n`;
  for (const res of new Set(sseClients)) res.write(data);
}

// ── Fastify server ────────────────────────────────────────────────────────────

const fastify = Fastify({ logger: false });

fastify.register(fastifyStatic, {
  root:  _uiDir,
  index: false,
});

fastify.get("/", async (_req, reply) => {
  const html   = readFileSync(resolve(_uiDir, "index.html"), "utf8");
  const init   = JSON.stringify({
    stats:      statsSnapshot(),
    log:        requestLog,
    schemas:    JSON.parse(_toolSchemasJson) as unknown[],
    serverInfo: JSON.parse(_serverInfoJson) as unknown,
    memory:     memStats(),
  });
  const inject = `<script>window.__INIT__=${init}</script>`;
  const out    = html.replace("</head>", `${inject}\n</head>`);
  return reply.header("Content-Type", "text/html; charset=utf-8").send(out);
});

fastify.get("/events", (req, reply) => {
  reply.hijack();
  const raw = reply.raw;
  raw.setHeader("Content-Type",  "text/event-stream");
  raw.setHeader("Cache-Control", "no-cache");
  raw.setHeader("Connection",    "keep-alive");
  raw.flushHeaders();
  raw.write(`data: ${JSON.stringify({ type: "init", stats: statsSnapshot(), log: requestLog, reindex: _reindexProgress, memory: memStats() })}\n\n`);
  sseClients.add(raw);
  req.raw.on("close", () => { sseClients.delete(raw); });
});

fastify.get("/api/stats", async (_req, _reply) => {
  return { stats: statsSnapshot(), memory: memStats() };
});

fastify.post<{ Body: { tool: string; args: Record<string, unknown> } }>("/api/run", (req, reply) => {
  const t0      = Date.now();
  const { tool, args } = req.body;
  const bytesIn = JSON.stringify(args ?? {}).length;
  void _dispatch!(tool, args ?? {})
    .then(result => {
      const ms = Date.now() - t0;
      record(tool, "playground", bytesIn, result.length, ms, true);
      void reply.send({ ok: true, result, ms });
    })
    .catch((err: unknown) => {
      const ms     = Date.now() - t0;
      const errStr = err instanceof Error ? (err.stack ?? err.message) : String(err);
      record(tool, "playground", bytesIn, 0, ms, false, errStr);
      void reply.code(500).send({ ok: false, error: String(err), ms });
    });
});

// ── Exports ───────────────────────────────────────────────────────────────────

// ── Reindex progress exports ──────────────────────────────────────────────────

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

export function startDashboard(port: number, toolSchemas: ToolSchemaDef[], dispatch: DispatchFn): void {
  _active = true;
  _dispatch = dispatch;
  _serverInfo = {
    projectId:            cfg.projectId,
    agentId:              cfg.agentId,
    version:              PKG_VERSION,
    watch:                cfg.watch,
    branch:               getCurrentBranch(cfg.projectRoot),
    collectionPrefix:     cfg.collectionPrefix,
    embedProvider:        cfg.embedProvider,
    embedModel:           cfg.embedModel,
    llmProvider:          cfg.llmProvider,
    llmModel:             cfg.llmModel,
    generateDescriptions: cfg.generateDescriptions,
  };
  _serverInfoJson = JSON.stringify(_serverInfo);
  _toolSchemasJson = JSON.stringify(toolSchemas);
  process.on("SIGINT",  () => { broadcastShutdown(); process.exit(0); });
  process.on("SIGTERM", () => { broadcastShutdown(); process.exit(0); });
  fastify.listen({ port, host: "127.0.0.1" })
    .then(() => {
      const addr = fastify.server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      const url = `http://localhost:${actualPort}`;
      process.stderr.write(`[dashboard] ${url}\n`);
      openBrowser(url);
      fastify.server.unref();
    })
    .catch((err: unknown) => {
      process.stderr.write(`[dashboard] HTTP error: ${String(err)}\n`);
    });
}
