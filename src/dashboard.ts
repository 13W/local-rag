import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import type { ServerResponse } from "node:http";
import { spawn, spawnSync } from "node:child_process";
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
  generateDescriptions: boolean;
}

// ── Module-level state ────────────────────────────────────────────────────────

let _dispatch: DispatchFn | null = null;
let _toolSchemasJson = "[]";
let _serverInfoJson  = "{}";
let _active = false;

// ── In-memory state ───────────────────────────────────────────────────────────

const toolStats  = new Map<string, ToolStats>();
const LOG_MAX    = 500;
const requestLog: RequestEntry[] = [];
const sseClients = new Set<ServerResponse>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function statsSnapshot(): Record<string, ToolStats & { avgMs: number; tokensEst: number }> {
  const out: Record<string, ToolStats & { avgMs: number; tokensEst: number }> = {};
  for (const [tool, s] of toolStats) {
    out[tool] = {
      ...s,
      avgMs:     s.calls > 0 ? s.totalMs / s.calls : 0,
      tokensEst: Math.round((s.bytesIn + s.bytesOut) / 4),
    };
  }
  return out;
}

export function record(tool: string, source: "mcp" | "playground", bytesIn: number, bytesOut: number, ms: number, ok: boolean): void {
  const prev = toolStats.get(tool) ?? { calls: 0, bytesIn: 0, bytesOut: 0, totalMs: 0, errors: 0 };
  toolStats.set(tool, {
    calls:    prev.calls    + 1,
    bytesIn:  prev.bytesIn  + bytesIn,
    bytesOut: prev.bytesOut + bytesOut,
    totalMs:  prev.totalMs  + ms,
    errors:   prev.errors   + (ok ? 0 : 1),
  });

  const entry: RequestEntry = { ts: Date.now(), tool, source, bytesIn, bytesOut, ms, ok };
  requestLog.push(entry);
  if (requestLog.length > LOG_MAX) requestLog.shift();

  const data = `data: ${JSON.stringify({ type: "entry", entry, stats: statsSnapshot() })}\n\n`;
  for (const res of new Set(sseClients)) res.write(data);
}

export function recordIndex(relPath: string, chunks: number, ms: number, ok: boolean): void {
  if (!_active) return;
  const entry: RequestEntry = { ts: Date.now(), tool: relPath, source: "watcher", bytesIn: 0, bytesOut: 0, ms, ok, chunks };
  requestLog.push(entry);
  if (requestLog.length > LOG_MAX) requestLog.shift();
  const data = `data: ${JSON.stringify({ type: "entry", entry, stats: statsSnapshot() })}\n\n`;
  for (const res of new Set(sseClients)) res.write(data);
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

export function broadcastError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack   = err instanceof Error ? (err.stack ?? "") : "";
  const data = `data: ${JSON.stringify({ type: "error", message, stack, ts: Date.now() })}\n\n`;
  for (const res of new Set(sseClients)) res.write(data);
}

function getCurrentBranch(root: string): string {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root || process.cwd(),
    encoding: "utf8",
    timeout: 2000,
  });
  return r.status === 0 ? r.stdout.trim() : "";
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
  raw.write(`data: ${JSON.stringify({ type: "init", stats: statsSnapshot(), log: requestLog })}\n\n`);
  sseClients.add(raw);
  req.raw.on("close", () => { sseClients.delete(raw); });
});

fastify.get("/api/stats", async (_req, _reply) => {
  return statsSnapshot();
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
      const ms = Date.now() - t0;
      void reply.code(500).send({ ok: false, error: String(err), ms });
    });
});

// ── Exports ───────────────────────────────────────────────────────────────────

export function startDashboard(port: number, toolSchemas: ToolSchemaDef[], dispatch: DispatchFn): void {
  _active = true;
  _dispatch = dispatch;
  _serverInfoJson = JSON.stringify({
    projectId:            cfg.projectId,
    agentId:              cfg.agentId,
    version:              PKG_VERSION,
    watch:                cfg.watch,
    branch:               getCurrentBranch(cfg.projectRoot),
    collectionPrefix:     cfg.collectionPrefix,
    embedProvider:        cfg.embedProvider,
    embedModel:           cfg.embedModel,
    generateDescriptions: cfg.generateDescriptions,
  } satisfies ServerInfo);
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
