#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const projectDir = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

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

await fetch(`${serverUrl}/api/projects`, {
  method:  "POST",
  headers: { "Content-Type": "application/json" },
  body:    JSON.stringify({
    project_id:   basename(projectDir),
    display_name: basename(projectDir),
    project_dir:  projectDir,
  }),
}).catch(() => null);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName:     "SessionStart",
    additionalContext: "Memory system active (local-rag). See MCP server instructions for the full protocol.",
  },
}));
