import { readLocalConfig, defaultLocalConfigPath } from "./local-config.js";

export async function runHookSessionEnd(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) { process.stdout.write("{}"); return; }

  // Parse CLI args: --project <id> [--agent <id>] [--agent-type <type>]
  let projectId = "default";
  let agentId   = "";
  let agentType = "unknown";

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) {
      projectId = args[i + 1]!;
      i++;
    } else if (args[i] === "--agent" && args[i + 1]) {
      agentId = args[i + 1]!;
      i++;
    } else if (args[i] === "--agent-type" && args[i + 1]) {
      agentType = args[i + 1]!;
      i++;
    }
  }
  if (!agentId) agentId = projectId;

  const localCfg = await readLocalConfig(defaultLocalConfigPath()).catch(() => null);
  const port      = localCfg?.port ?? 7531;
  const serverUrl = process.env["MEMORY_SERVER_URL"] ?? `http://127.0.0.1:${port}`;

  const url = new URL(`${serverUrl}/hooks/session-end`);
  url.searchParams.set("project",    projectId);
  url.searchParams.set("agent",      agentId);
  url.searchParams.set("agent_type", agentType);

  try {
    const res = await fetch(url.toString(), {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal:  AbortSignal.timeout(30_000),
    });
    if (!res.ok) { process.stdout.write("{}"); return; }
    const data = await res.text();
    process.stdout.write(data);
  } catch {
    process.stdout.write("{}");
  }
}
