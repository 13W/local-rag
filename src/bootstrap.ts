import { createInterface } from "node:readline/promises";
import { stdin, stdout }   from "node:process";
import { QdrantClient }    from "@qdrant/js-client-rest";
import {
  readLocalConfig, writeLocalConfig, defaultLocalConfigPath,
  type LocalConfig,
} from "./local-config.js";
import { initQdrant } from "./qdrant.js";

async function promptQdrantConfig(): Promise<LocalConfig["qdrant"]> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const url     = (await rl.question("Qdrant URL [http://localhost:6333]: ")).trim() || "http://localhost:6333";
    const api_key = (await rl.question("Qdrant API key (leave empty if none): ")).trim();
    const tlsStr  = (await rl.question("Use TLS? [y/N]: ")).trim().toLowerCase();
    return { url, api_key, tls: tlsStr === "y", prefix: "" };
  } finally {
    rl.close();
  }
}

async function tryConnect(url: string, apiKey?: string): Promise<boolean> {
  try {
    const client = new QdrantClient({ url, apiKey: apiKey || undefined, timeout: 5_000 });
    await client.getCollections();
    return true;
  } catch {
    return false;
  }
}

export async function bootstrap(): Promise<void> {
  const configPath = defaultLocalConfigPath();
  let localCfg = await readLocalConfig(configPath);

  // Try existing config first
  if (await tryConnect(localCfg.qdrant.url, localCfg.qdrant.api_key)) {
    initQdrant(localCfg.qdrant.url, localCfg.qdrant.api_key);
    process.stderr.write(`[bootstrap] Connected to Qdrant at ${localCfg.qdrant.url}\n`);
    return;
  }

  // Try localhost default
  if (localCfg.qdrant.url !== "http://localhost:6333") {
    if (await tryConnect("http://localhost:6333")) {
      localCfg.qdrant.url = "http://localhost:6333";
      localCfg.qdrant.api_key = "";
      await writeLocalConfig(configPath, localCfg);
      initQdrant("http://localhost:6333");
      process.stderr.write(`[bootstrap] Connected to Qdrant at http://localhost:6333\n`);
      return;
    }
  }

  // Prompt user
  process.stderr.write("[bootstrap] Cannot connect to Qdrant. Please provide connection details.\n");
  const qdrantCfg = await promptQdrantConfig();

  if (!await tryConnect(qdrantCfg.url, qdrantCfg.api_key)) {
    process.stderr.write(`[bootstrap] ERROR: Cannot connect to ${qdrantCfg.url}. Exiting.\n`);
    process.exit(1);
  }

  localCfg.qdrant = qdrantCfg;
  await writeLocalConfig(configPath, localCfg);
  initQdrant(qdrantCfg.url, qdrantCfg.api_key);
  process.stderr.write(`[bootstrap] Connected and saved config to ${configPath}\n`);
}
