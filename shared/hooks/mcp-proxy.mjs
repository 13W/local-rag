#!/usr/bin/env node
// Bridges Claude Code's stdio MCP to local-rag HTTP MCP server.
// Runs as a command-based MCP so CLAUDE_PROJECT_DIR is available from env.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const projectDir = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();

async function readLocalConfig() {
  try {
    const raw = await readFile(join(homedir(), ".config", "local-rag", "config.json"), "utf8");
    return JSON.parse(raw);
  } catch { return { port: 7531 }; }
}

const cfg = await readLocalConfig();
const serverUrl = process.env["MEMORY_SERVER_URL"] ?? `http://localhost:${cfg.port ?? 7531}`;
const mcpUrl = `${serverUrl}/mcp?project_dir=${encodeURIComponent(projectDir)}`;

const rl = createInterface({ input: process.stdin, terminal: false });

// Write a JSON-RPC error response so the client doesn't hang waiting for a reply.
// JSON-RPC notifications have no id and expect no response — skip those.
function emitError(reqId, message) {
  if (reqId === undefined || reqId === null) return;
  const resp = { jsonrpc: "2.0", id: reqId, error: { code: -32603, message } };
  process.stdout.write(JSON.stringify(resp) + "\n");
}

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  let reqId;
  try { reqId = JSON.parse(trimmed)?.id; } catch { /* leave undefined */ }

  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: trimmed,
      signal: AbortSignal.timeout(120_000),
    });

    const ct = res.headers.get("content-type") ?? "";

    if (ct.includes("text/event-stream")) {
      const text = await res.text();
      let emitted = false;
      for (const sseLine of text.split("\n")) {
        if (sseLine.startsWith("data: ")) {
          const data = sseLine.slice(6).trim();
          if (data && data !== "[DONE]") { process.stdout.write(data + "\n"); emitted = true; }
        }
      }
      if (!emitted) emitError(reqId, "empty SSE response from server");
    } else {
      const text = (await res.text()).trim();
      if (text) process.stdout.write(text + "\n");
      else emitError(reqId, "empty response from server");
    }
  } catch (err) {
    process.stderr.write(`[mcp-proxy] ${err}\n`);
    emitError(reqId, `proxy error: ${err}`);
  }
}
