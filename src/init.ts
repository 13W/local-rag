import { createInterface }   from "node:readline/promises";
import { stdin, stdout }     from "node:process";
import { basename, resolve } from "node:path";
import { readLocalConfig, defaultLocalConfigPath } from "./local-config.js";
import { mergeProjectConfig } from "./server-config.js";

async function prompt(rl: ReturnType<typeof createInterface>, question: string, def = ""): Promise<string> {
  const answer = (await rl.question(question)).trim();
  return answer || def;
}

export async function init(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    // 1. Resolve server URL
    const localCfg  = await readLocalConfig(defaultLocalConfigPath()).catch(() => null);
    const port       = localCfg?.port ?? 7531;
    const serverUrl  = process.env["MEMORY_SERVER_URL"] ?? `http://127.0.0.1:${port}`;

    // 2. Verify server is running
    const health = await fetch(`${serverUrl}/api/stats`).catch(() => null);
    if (!health?.ok) {
      process.stderr.write(`[init] ERROR: Server not running at ${serverUrl}. Run 'local-rag serve' first.\n`);
      process.exit(1);
    }

    // 3. Gather project info
    const defaultName = basename(resolve(process.cwd()));
    const projectId   = await prompt(rl, `Project name [${defaultName}]: `, defaultName);
    const agentId     = await prompt(rl, `Agent name [${projectId}]: `, projectId);

    // 4. Create project on server
    const proj = mergeProjectConfig({
      project_id: projectId,
      agent_id: agentId,
      display_name: projectId,
      project_root: resolve(process.cwd())
    });
    const res  = await fetch(`${serverUrl}/api/projects`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(proj),
    });
    if (!res.ok) {
      process.stderr.write(`[init] ERROR: Failed to create project: ${await res.text()}\n`);
      process.exit(1);
    }

    // 5. Configure hooks in .claude/settings.json
    await configureHooks(projectId, agentId, serverUrl);

    // 6. Print dashboard URL
    process.stderr.write(`\n[init] Project '${projectId}' created.\n`);
    process.stderr.write(`[init] Dashboard: ${serverUrl}/?project=${projectId}\n`);
    process.stderr.write(`[init] Open the dashboard to configure include paths and start indexing.\n`);
  } finally {
    rl.close();
  }
}

async function configureHooks(projectId: string, agentId: string, serverUrl: string): Promise<void> {
  const { writeFileSync, existsSync, readFileSync, mkdirSync } = await import("node:fs");
  const settingsPath = resolve(process.cwd(), ".claude", "settings.json");
  mkdirSync(resolve(process.cwd(), ".claude"), { recursive: true });

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>; } catch {}
  }

  // Set MCP server URL with project/agent params
  const mcpUrl = `${serverUrl}/mcp?project=${projectId}&agent=${agentId}`;
  const mcpServers = (settings["mcpServers"] ?? {}) as Record<string, unknown>;
  mcpServers["memory"] = { url: mcpUrl };
  settings["mcpServers"] = mcpServers;

  // Configure hooks to use local-rag subprocesses
  const hooks = (settings["hooks"] ?? {}) as Record<string, unknown[]>;
  hooks["PreToolUse"] = [{ matcher: ".*", hooks: [{ type: "command", command: "local-rag hook-recall" }] }];
  hooks["Stop"]       = [{ hooks: [{ type: "command", command: "local-rag hook-remember" }] }];
  settings["hooks"]   = hooks;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  process.stderr.write(`[init] Configured .claude/settings.json (hooks + MCP at ${mcpUrl})\n`);
}
