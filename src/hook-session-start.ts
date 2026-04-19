import { readLocalConfig, defaultLocalConfigPath } from "./local-config.js";
import { basename } from "node:path";

const SESSION_START_MESSAGE = `Memory system active (local-rag). See MCP server instructions for the full protocol.`;

export async function runHookSessionStart(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);

  let projectDir = "";
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project-dir" && args[i + 1]) { projectDir = args[i + 1]!; i++; }
  }

  if (projectDir) {
    const localCfg  = await readLocalConfig(defaultLocalConfigPath()).catch(() => null);
    const port      = localCfg?.port ?? 7531;
    const serverUrl = process.env["MEMORY_SERVER_URL"] ?? `http://127.0.0.1:${port}`;
    await fetch(`${serverUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: basename(projectDir), display_name: basename(projectDir), project_dir: projectDir }),
    }).catch(() => null);
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: SESSION_START_MESSAGE },
  }));
}
