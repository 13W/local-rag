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
    const health = await fetch(`${serverUrl}/api/init`).catch(() => null);
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

    // 5. Configure hooks
    await configureClaudeHooks(projectId, agentId, serverUrl);
    await configureGeminiHooks(projectId, agentId, serverUrl);

    // 6. Print dashboard URL
    process.stderr.write(`\n[init] Project '${projectId}' created.\n`);
    process.stderr.write(`[init] Dashboard: ${serverUrl}/?project=${projectId}\n`);
    process.stderr.write(`[init] Open the dashboard to configure include paths and start indexing.\n`);
  } finally {
    rl.close();
  }
}

async function configureClaudeHooks(projectId: string, agentId: string, serverUrl: string): Promise<void> {
  const { writeFileSync, existsSync, readFileSync, mkdirSync } = await import("node:fs");
  const claudeDir = resolve(process.cwd(), ".claude");
  const localSettingsPath = resolve(claudeDir, "settings.local.json");
  const mainSettingsPath  = resolve(claudeDir, "settings.json");

  // Determine which file to use: settings.local.json if it exists, otherwise create it.
  const settingsPath = existsSync(localSettingsPath) ? localSettingsPath : localSettingsPath;
  mkdirSync(claudeDir, { recursive: true });

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>; } catch {}
  } else if (existsSync(mainSettingsPath)) {
    // If local doesn't exist but main does, we might want to see if we should copy or just start fresh.
    // User requested to use local to avoid committing.
  }

  const mcpUrl = `${serverUrl}/mcp?project=${projectId}&agent=${agentId}`;
  const mcpServers = (settings["mcpServers"] ?? {}) as Record<string, unknown>;
  mcpServers["memory"] = { type: "http", url: mcpUrl };
  settings["mcpServers"] = mcpServers;

  const hooks = (settings["hooks"] ?? {}) as Record<string, unknown[]>;
  // For Claude Code: UserPromptSubmit for recall, Stop for remember
  hooks["UserPromptSubmit"] = [{ matcher: ".*", hooks: [{ type: "command", command: `local-rag hook-recall --project ${projectId} --agent ${agentId}` }] }];
  hooks["Stop"]             = [{ hooks: [{ type: "command", command: `local-rag hook-remember --project ${projectId} --agent ${agentId}` }] }];
  
  // Clean up old hooks if any
  delete hooks["PreToolUse"];
  
  settings["hooks"] = hooks;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  process.stderr.write(`[init] Configured ${basename(settingsPath)} (Claude Code)\n`);
}

async function configureGeminiHooks(projectId: string, agentId: string, serverUrl: string): Promise<void> {
  const { writeFileSync, existsSync, readFileSync, mkdirSync } = await import("node:fs");
  const geminiDir = resolve(process.cwd(), ".gemini");
  
  // Only configure if .gemini directory exists (user is using gemini-cli)
  if (!existsSync(geminiDir)) return;

  const settingsPath = resolve(geminiDir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>; } catch {}
  }

  const mcpUrl = `${serverUrl}/mcp?project=${projectId}&agent=${agentId}`;
  const mcpServers = (settings["mcpServers"] ?? {}) as Record<string, unknown>;
  mcpServers["memory"] = { type: "http", url: mcpUrl };
  settings["mcpServers"] = mcpServers;

  const hooks = (settings["hooks"] ?? {}) as Record<string, unknown[]>;
  // For Gemini CLI: BeforeAgent for recall, AfterAgent for remember
  hooks["BeforeAgent"] = [{ matcher: ".*", hooks: [{ type: "command", command: `local-rag hook-recall --project ${projectId} --agent ${agentId}` }] }];
  hooks["AfterAgent"]  = [{ hooks: [{ type: "command", command: `local-rag hook-remember --project ${projectId} --agent ${agentId}` }] }];
  settings["hooks"] = hooks;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  process.stderr.write(`[init] Configured .gemini/settings.json (Gemini CLI)\n`);
}
