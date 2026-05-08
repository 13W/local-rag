#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const projectDir = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const body = Buffer.concat(chunks).toString("utf8").trim();
if (!body) { process.stdout.write("{}"); process.exit(0); }

async function readLocalConfig() {
  try {
    const raw = await readFile(join(homedir(), ".config", "local-rag", "config.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return { port: 7531 };
  }
}

const localCfg  = await readLocalConfig();
const port      = localCfg.port ?? 7531;
const serverUrl = process.env["MEMORY_SERVER_URL"] ?? `http://127.0.0.1:${port}`;

const url = new URL(`${serverUrl}/hooks/remember`);
url.searchParams.set("project_dir", projectDir);

try {
  const res = await fetch(url.toString(), {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal:  AbortSignal.timeout(120_000),
  });
  process.stdout.write(res.ok ? await res.text() : "{}");
} catch {
  process.stdout.write("{}");
}
