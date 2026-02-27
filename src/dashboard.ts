import { createServer, type ServerResponse, type IncomingMessage } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cfg } from "./config.js";

const _dir = dirname(fileURLToPath(import.meta.url));
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

function getCurrentBranch(root: string): string {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root || process.cwd(),
    encoding: "utf8",
    timeout: 2000,
  });
  return r.status === 0 ? r.stdout.trim() : "";
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────

function buildDashboardHtml(toolSchemasJson: string, serverInfoJson: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: monospace; background: #1a1a2e; color: #e0e0e0; margin: 0; padding: 1rem; }
    h1 { color: #7dd3fc; margin: 0 0 0.25rem; font-size: 1.4rem; }
    h2 { color: #a5b4fc; font-size: 0.9rem; margin: 1.5rem 0 0.4rem; text-transform: uppercase; letter-spacing: .07em; }
    #status { font-size: 0.75rem; color: #6b7280; }
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    th { background: #2d2d4e; color: #a5b4fc; padding: 0.35rem 0.6rem; text-align: left; }
    td { padding: 0.28rem 0.6rem; border-bottom: 1px solid #22223a; }
    tr:hover td { background: #2d2d4e55; }
    .ok  { color: #4ade80; }
    .err { color: #f87171; }
    .log-wrap { max-height: 420px; overflow-y: auto; border: 1px solid #2d2d4e; border-radius: 4px; }
    .pg-input { width: 100%; background: #0f0f23; color: #e0e0e0; border: 1px solid #3d3d6e; padding: 0.35rem; font-family: monospace; font-size: 0.78rem; }
    .pg-label { display: block; color: #a5b4fc; font-size: 0.8rem; margin-bottom: 0.2rem; }
    .pg-field { margin-bottom: 0.5rem; }
    #pg-run { background: #4f46e5; color: #fff; border: none; padding: 0.4rem 1rem; font-family: monospace; cursor: pointer; border-radius: 3px; font-size: 0.82rem; }
    #pg-run:disabled { opacity: 0.5; cursor: not-allowed; }
    #pg-run:hover:not(:disabled) { background: #4338ca; }
    #pg-status { font-size: 0.8rem; margin-left: 0.75rem; }
    #pg-out { background: #0f0f23; border: 1px solid #2d2d4e; border-radius: 4px; padding: 0.75rem; margin-top: 0.5rem; max-height: 400px; overflow: auto; font-size: 0.78rem; color: #e0e0e0; white-space: pre-wrap; word-break: break-all; min-height: 2.5rem; }
    .src-mcp   { background: #1e3a5f; color: #7dd3fc; padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.72rem; }
    .src-pg    { background: #3d2a00; color: #fbbf24; padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.72rem; }
    .src-watch { background: #064e3b; color: #34d399; padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.72rem; }
    .info-bar { display:flex; flex-wrap:wrap; gap:0.3rem 0.6rem; margin:0.4rem 0 1rem; font-size:0.76rem; }
    .info-tag { background:#2d2d4e; padding:0.15rem 0.45rem; border-radius:3px; white-space:nowrap; }
    .info-tag .lbl { color:#6b7280; }
    .info-tag .val { color:#e0e0e0; }
    .info-tag .val.on  { color:#4ade80; }
    .info-tag .val.off { color:#f87171; }
    .info-tag .val.branch { color:#fbbf24; }
  </style>
</head>
<body>
  <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.1rem">
    <svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <radialGradient id="lg" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#7dd3fc" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="#7dd3fc" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <!-- glow -->
      <circle cx="20" cy="20" r="18" fill="url(#lg)"/>
      <!-- hex outline -->
      <polygon points="20,2 35,11 35,29 20,38 5,29 5,11"
               fill="none" stroke="#a5b4fc" stroke-width="0.8" stroke-opacity="0.45"/>
      <!-- spokes center\u2192vertex -->
      <line x1="20" y1="20" x2="20" y2="2"   stroke="#7dd3fc" stroke-width="0.7" stroke-opacity="0.35"/>
      <line x1="20" y1="20" x2="35" y2="11"  stroke="#7dd3fc" stroke-width="0.7" stroke-opacity="0.35"/>
      <line x1="20" y1="20" x2="35" y2="29"  stroke="#7dd3fc" stroke-width="0.7" stroke-opacity="0.35"/>
      <line x1="20" y1="20" x2="20" y2="38"  stroke="#7dd3fc" stroke-width="0.7" stroke-opacity="0.35"/>
      <line x1="20" y1="20" x2="5"  y2="29"  stroke="#7dd3fc" stroke-width="0.7" stroke-opacity="0.35"/>
      <line x1="20" y1="20" x2="5"  y2="11"  stroke="#7dd3fc" stroke-width="0.7" stroke-opacity="0.35"/>
      <!-- inner triangle \u25b2 -->
      <polygon points="20,2 35,29 5,29"
               fill="none" stroke="#a5b4fc" stroke-width="0.65" stroke-opacity="0.3"/>
      <!-- inner triangle \u25bc -->
      <polygon points="20,38 35,11 5,11"
               fill="none" stroke="#a5b4fc" stroke-width="0.65" stroke-opacity="0.3"/>
      <!-- vertex nodes -->
      <circle cx="20" cy="2"  r="1.8" fill="#a5b4fc"/>
      <circle cx="35" cy="11" r="1.8" fill="#a5b4fc"/>
      <circle cx="35" cy="29" r="1.8" fill="#a5b4fc"/>
      <circle cx="20" cy="38" r="1.8" fill="#a5b4fc"/>
      <circle cx="5"  cy="29" r="1.8" fill="#a5b4fc"/>
      <circle cx="5"  cy="11" r="1.8" fill="#a5b4fc"/>
      <!-- center core: ring + dot -->
      <circle cx="20" cy="20" r="4"   fill="#7dd3fc"/>
      <circle cx="20" cy="20" r="2.4" fill="#1a1a2e"/>
      <circle cx="20" cy="20" r="1.3" fill="#7dd3fc"/>
    </svg>
    <h1 style="margin:0">MCP Tool Dashboard</h1>
  </div>
  <div id="status">connecting\u2026</div>
  <div id="info-bar" class="info-bar"></div>
  <h2>Tool Stats</h2>
  <table id="stats-tbl">
    <thead><tr><th>Tool</th><th>Calls</th><th>Bytes In</th><th>Bytes Out</th><th>Avg ms</th><th>Est Tokens</th><th>Errors</th></tr></thead>
    <tbody></tbody>
  </table>
  <h2>Request Log <span style="font-weight:normal;font-size:0.75rem;color:#6b7280">(newest first, max 500)</span></h2>
  <div class="log-wrap">
    <table id="log-tbl">
      <thead><tr><th>Time</th><th>Tool</th><th>Source</th><th>In</th><th>Out</th><th>ms</th><th>OK</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
  <h2>Playground</h2>
  <div style="display:grid;grid-template-columns:200px 1fr;gap:1rem;align-items:start">
    <div>
      <label class="pg-label" for="pg-tool">Tool</label>
      <select id="pg-tool" class="pg-input" style="cursor:pointer">
        <option value="">\u2014 select \u2014</option>
      </select>
    </div>
    <div id="pg-form"></div>
  </div>
  <div style="margin-top:0.75rem;display:flex;align-items:center">
    <button id="pg-run">Run \u25b6</button>
    <span id="pg-status"></span>
  </div>
  <pre id="pg-out"></pre>
  <script>
    const SERVER_INFO = ${serverInfoJson};
    (function renderInfo() {
      const bar = document.getElementById('info-bar');
      const add = (lbl, val, cls) => {
        const tag = document.createElement('span');
        tag.className = 'info-tag';
        tag.innerHTML = '<span class="lbl">' + lbl + '</span> <span class="val' + (cls ? ' ' + cls : '') + '">' + val + '</span>';
        bar.appendChild(tag);
      };
      add('project', SERVER_INFO.projectId);
      add('agent',   SERVER_INFO.agentId);
      add('v',       SERVER_INFO.version);
      add('index',   SERVER_INFO.watch ? '\u2713 on' : '\u2717 off', SERVER_INFO.watch ? 'on' : 'off');
      add('descriptions', SERVER_INFO.generateDescriptions ? '\u2713 on' : '\u2717 off', SERVER_INFO.generateDescriptions ? 'on' : 'off');
      if (SERVER_INFO.branch) add('branch', SERVER_INFO.branch, 'branch');
      if (SERVER_INFO.collectionPrefix) add('prefix', SERVER_INFO.collectionPrefix);
      add('embed', SERVER_INFO.embedProvider + ':' + SERVER_INFO.embedModel);
    })();
    const statsTbody = document.querySelector('#stats-tbl tbody');
    const logTbody   = document.querySelector('#log-tbl tbody');
    const statusEl   = document.getElementById('status');

    function fmtBytes(n) { return n >= 1024 ? (n / 1024).toFixed(1) + 'K' : String(n); }
    function fmtTime(ts) { return new Date(ts).toTimeString().slice(0, 8); }

    function renderStats(stats) {
      statsTbody.innerHTML = '';
      for (const [tool, s] of Object.entries(stats).sort()) {
        const tr = document.createElement('tr');
        const addCell = (text, cls) => {
          const td = document.createElement('td');
          td.textContent = text;
          if (cls) td.className = cls;
          tr.appendChild(td);
        };
        addCell(tool);
        addCell(String(s.calls));
        addCell(fmtBytes(s.bytesIn));
        addCell(fmtBytes(s.bytesOut));
        addCell(s.avgMs.toFixed(0));
        addCell(String(s.tokensEst));
        addCell(String(s.errors), s.errors > 0 ? 'err' : 'ok');
        statsTbody.appendChild(tr);
      }
    }

    function appendRow(entry) {
      const tr = document.createElement('tr');
      const addCell = (text, cls) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (cls) td.className = cls;
        tr.appendChild(td);
      };
      const addBadgeCell = (source) => {
        const td = document.createElement('td');
        const span = document.createElement('span');
        span.className = source === 'mcp' ? 'src-mcp' : source === 'playground' ? 'src-pg' : 'src-watch';
        span.textContent = source === 'playground' ? 'pg' : source === 'watcher' ? 'watch' : source;
        td.appendChild(span);
        tr.appendChild(td);
      };
      addCell(fmtTime(entry.ts));
      addCell(entry.tool);
      addBadgeCell(entry.source);
      addCell(entry.source === 'watcher' ? '\u2014' : fmtBytes(entry.bytesIn));
      addCell(entry.source === 'watcher' ? (entry.chunks != null ? entry.chunks + '\u00a0ch' : '\u2014') : fmtBytes(entry.bytesOut));
      addCell(String(entry.ms));
      addCell(entry.ok ? '\u2713' : '\u2717', entry.ok ? 'ok' : 'err');
      logTbody.insertBefore(tr, logTbody.firstChild);
    }

    function trimLog() {
      while (logTbody.rows.length > 500) logTbody.deleteRow(logTbody.rows.length - 1);
    }

    const es = new EventSource('/events');
    es.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.type === 'init')     { statusEl.textContent = 'connected'; statusEl.style.color = ''; renderStats(msg.stats); msg.log.toReversed().forEach(appendRow); }
      if (msg.type === 'entry')    { renderStats(msg.stats); appendRow(msg.entry); trimLog(); }
      if (msg.type === 'shutdown') { window.close(); }
    };
    es.onerror = () => {
      statusEl.textContent = 'disconnected';
      statusEl.style.color = '#f87171';
      document.title = 'disconnected';
    };

    // ── Playground ──────────────────────────────────────────────────────────────
    const TOOL_SCHEMAS = ${toolSchemasJson};
    const pgTool   = document.getElementById('pg-tool');
    const pgForm   = document.getElementById('pg-form');
    const pgRun    = document.getElementById('pg-run');
    const pgStatus = document.getElementById('pg-status');
    const pgOut    = document.getElementById('pg-out');

    TOOL_SCHEMAS.forEach(function(schema) {
      const opt = document.createElement('option');
      opt.value = schema.name;
      opt.textContent = schema.name;
      pgTool.appendChild(opt);
    });

    function renderForm(toolName) {
      pgForm.innerHTML = '';
      if (!toolName) return;
      const schema = TOOL_SCHEMAS.find(function(s) { return s.name === toolName; });
      if (!schema) return;
      const props = schema.inputSchema.properties || {};
      const req   = schema.inputSchema.required   || [];
      Object.keys(props).forEach(function(key) {
        const prop = props[key];
        const required = req.indexOf(key) !== -1;
        const wrap = document.createElement('div');
        wrap.className = 'pg-field';
        const lbl = document.createElement('label');
        lbl.className = 'pg-label';
        lbl.setAttribute('for', 'pg-field-' + key);
        lbl.textContent = key + (required ? ' *' : '');
        wrap.appendChild(lbl);
        var input;
        if (key === 'content' && prop.type === 'string') {
          input = document.createElement('textarea');
          input.rows = 4;
          input.className = 'pg-input';
          input.style.resize = 'vertical';
        } else if (prop.type === 'boolean') {
          input = document.createElement('input');
          input.type = 'checkbox';
          if (prop.default === true) input.checked = true;
        } else if (prop.type === 'number' || prop.type === 'integer') {
          input = document.createElement('input');
          input.type = 'number';
          input.className = 'pg-input';
          if (prop.default !== undefined) input.value = String(prop.default);
        } else {
          input = document.createElement('input');
          input.type = 'text';
          input.className = 'pg-input';
          if (prop.default !== undefined) input.value = String(prop.default);
        }
        input.id = 'pg-field-' + key;
        input.dataset.key  = key;
        input.dataset.type = prop.type || 'string';
        wrap.appendChild(input);
        pgForm.appendChild(wrap);
      });
    }

    pgTool.addEventListener('change', function() { renderForm(pgTool.value); });

    pgRun.addEventListener('click', function() {
      var toolName = pgTool.value;
      if (!toolName) return;
      var schema = TOOL_SCHEMAS.find(function(s) { return s.name === toolName; });
      if (!schema) return;
      var props = schema.inputSchema.properties || {};
      var args = {};
      Object.keys(props).forEach(function(key) {
        var input = document.getElementById('pg-field-' + key);
        if (!input) return;
        var type = input.dataset.type;
        if (type === 'boolean') {
          args[key] = input.checked;
        } else if (type === 'number' || type === 'integer') {
          var v = input.value.trim();
          if (v !== '') args[key] = Number(v);
        } else {
          var val = input.value;
          if (val !== '') args[key] = val;
        }
      });
      pgRun.disabled = true;
      pgStatus.textContent = 'running\u2026';
      pgStatus.className = '';
      pgOut.textContent = '';
      fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: toolName, args: args })
      }).then(function(r) { return r.json(); }).then(function(data) {
        pgRun.disabled = false;
        if (data.ok) {
          pgStatus.textContent = '\u2713 ' + data.ms + 'ms';
          pgStatus.className = 'ok';
        } else {
          pgStatus.textContent = '\u2717 ' + data.ms + 'ms';
          pgStatus.className = 'err';
        }
        pgOut.textContent = data.ok ? data.result : data.error;
      }).catch(function(err) {
        pgRun.disabled = false;
        pgStatus.textContent = '\u2717 error';
        pgStatus.className = 'err';
        pgOut.textContent = String(err);
      });
    });
  </script>
</body>
</html>`;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === "/events") {
    res.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "init", stats: statsSnapshot(), log: requestLog })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  if (req.url === "/api/stats") {
    const body = JSON.stringify(statsSnapshot());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
    return;
  }
  if (req.method === "POST" && req.url === "/api/run") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const t0 = Date.now();
      Promise.resolve(Buffer.concat(chunks).toString())
        .then(raw => JSON.parse(raw) as { tool: string; args: Record<string, unknown> })
        .then(({ tool, args }) => {
          const bytesIn = JSON.stringify(args ?? {}).length;
          return _dispatch!(tool, args ?? {}).then(result => ({ tool, bytesIn, result }));
        })
        .then(({ tool, bytesIn, result }) => {
          const ms = Date.now() - t0;
          record(tool, "playground", bytesIn, result.length, ms, true);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, result, ms }));
        })
        .catch((err: unknown) => {
          const ms = Date.now() - t0;
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(err), ms }));
        });
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(buildDashboardHtml(_toolSchemasJson, _serverInfoJson));
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
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    process.stderr.write(`[dashboard] HTTP error: ${err.message}\n`);
  });
  httpServer.on("listening", () => {
    const addr = httpServer.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    const url = `http://localhost:${actualPort}`;
    process.stderr.write(`[dashboard] ${url}\n`);
    openBrowser(url);
  });
  process.on("SIGINT",  () => { broadcastShutdown(); process.exit(0); });
  process.on("SIGTERM", () => { broadcastShutdown(); process.exit(0); });
  httpServer.listen(port);
  httpServer.unref();
}
