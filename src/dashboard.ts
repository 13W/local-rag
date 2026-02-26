import { createServer, type ServerResponse, type IncomingMessage } from "node:http";
import { spawn } from "node:child_process";

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
  bytesIn:  number;
  bytesOut: number;
  ms:       number;
  ok:       boolean;
}

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

export function record(tool: string, bytesIn: number, bytesOut: number, ms: number, ok: boolean): void {
  const prev = toolStats.get(tool) ?? { calls: 0, bytesIn: 0, bytesOut: 0, totalMs: 0, errors: 0 };
  toolStats.set(tool, {
    calls:    prev.calls    + 1,
    bytesIn:  prev.bytesIn  + bytesIn,
    bytesOut: prev.bytesOut + bytesOut,
    totalMs:  prev.totalMs  + ms,
    errors:   prev.errors   + (ok ? 0 : 1),
  });

  const entry: RequestEntry = { ts: Date.now(), tool, bytesIn, bytesOut, ms, ok };
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

function broadcastShutdown(): void {
  const data = `data: ${JSON.stringify({ type: "shutdown" })}\n\n`;
  for (const res of new Set(sseClients)) res.write(data);
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
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
      <!-- spokes center→vertex -->
      <line x1="20" y1="20" x2="20" y2="2"   stroke="#7dd3fc" stroke-width="0.7" stroke-opacity="0.35"/>
      <line x1="20" y1="20" x2="35" y2="11"  stroke="#7dd3fc" stroke-width="0.7" stroke-opacity="0.35"/>
      <line x1="20" y1="20" x2="35" y2="29"  stroke="#7dd3fc" stroke-width="0.7" stroke-opacity="0.35"/>
      <line x1="20" y1="20" x2="20" y2="38"  stroke="#7dd3fc" stroke-width="0.7" stroke-opacity="0.35"/>
      <line x1="20" y1="20" x2="5"  y2="29"  stroke="#7dd3fc" stroke-width="0.7" stroke-opacity="0.35"/>
      <line x1="20" y1="20" x2="5"  y2="11"  stroke="#7dd3fc" stroke-width="0.7" stroke-opacity="0.35"/>
      <!-- inner triangle ▲ -->
      <polygon points="20,2 35,29 5,29"
               fill="none" stroke="#a5b4fc" stroke-width="0.65" stroke-opacity="0.3"/>
      <!-- inner triangle ▼ -->
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
  <h2>Tool Stats</h2>
  <table id="stats-tbl">
    <thead><tr><th>Tool</th><th>Calls</th><th>Bytes In</th><th>Bytes Out</th><th>Avg ms</th><th>Est Tokens</th><th>Errors</th></tr></thead>
    <tbody></tbody>
  </table>
  <h2>Request Log <span style="font-weight:normal;font-size:0.75rem;color:#6b7280">(newest first, max 500)</span></h2>
  <div class="log-wrap">
    <table id="log-tbl">
      <thead><tr><th>Time</th><th>Tool</th><th>In</th><th>Out</th><th>ms</th><th>OK</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
  <script>
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
      addCell(fmtTime(entry.ts));
      addCell(entry.tool);
      addCell(fmtBytes(entry.bytesIn));
      addCell(fmtBytes(entry.bytesOut));
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
      if (msg.type === 'init')     { statusEl.textContent = 'connected'; renderStats(msg.stats); msg.log.toReversed().forEach(appendRow); }
      if (msg.type === 'entry')    { renderStats(msg.stats); appendRow(msg.entry); trimLog(); }
      if (msg.type === 'shutdown') { window.close(); }
    };
    es.onerror = () => {
      document.body.innerHTML = '<div style="font:2rem monospace;padding:2rem;color:#f55">MCP server stopped.</div>';
      document.title = 'disconnected';
    };
  </script>
</body>
</html>`;

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
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(DASHBOARD_HTML);
});

// ── Exports ───────────────────────────────────────────────────────────────────

export function startDashboard(port: number): void {
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
}
