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

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;

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
      for (const sseLine of text.split("\n")) {
        if (sseLine.startsWith("data: ")) {
          const data = sseLine.slice(6).trim();
          if (data && data !== "[DONE]") process.stdout.write(data + "\n");
        }
      }
    } else {
      const text = (await res.text()).trim();
      if (text) process.stdout.write(text + "\n");
    }
  } catch (err) {
    process.stderr.write(`[mcp-proxy] ${err}\n`);
  }
}
