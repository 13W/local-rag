import { readLocalConfig, defaultLocalConfigPath } from "./local-config.js";

export async function runHookSessionEnd(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8").trim();

  let projectDir = "";
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project-dir" && args[i + 1]) { projectDir = args[i + 1]!; i++; }
  }

  const localCfg  = await readLocalConfig(defaultLocalConfigPath()).catch(() => null);
  const port      = localCfg?.port ?? 7531;
  const serverUrl = process.env["MEMORY_SERVER_URL"] ?? `http://127.0.0.1:${port}`;

  const url = new URL(`${serverUrl}/hooks/session-end`);
  if (projectDir) url.searchParams.set("project_dir", projectDir);

  try {
    const res = await fetch(url.toString(), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: body || "{}", signal: AbortSignal.timeout(30_000),
    });
    process.stdout.write(res.ok ? await res.text() : "{}");
  } catch {
    process.stdout.write("{}");
  }
}
