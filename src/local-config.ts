import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface QdrantConnectionConfig {
  url:     string;
  api_key: string;
  tls:     boolean;
  prefix:  string;
}

export interface LocalConfig {
  qdrant: QdrantConnectionConfig;
  port:   number;
}

const DEFAULTS: LocalConfig = {
  qdrant: { url: "http://localhost:6333", api_key: "", tls: false, prefix: "" },
  port:   7531,
};

export function defaultLocalConfigPath(): string {
  return join(homedir(), ".config", "local-rag", "config.json");
}

export async function readLocalConfig(path = defaultLocalConfigPath()): Promise<LocalConfig> {
  if (!existsSync(path)) return structuredClone(DEFAULTS);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalConfig>;
    return {
      qdrant: { ...DEFAULTS.qdrant, ...(parsed.qdrant ?? {}) },
      port:   parsed.port ?? DEFAULTS.port,
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export async function writeLocalConfig(path: string, config: LocalConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), "utf8");
}

export async function updateLocalConfigPort(port: number, path = defaultLocalConfigPath()): Promise<void> {
  const current = await readLocalConfig(path);
  await writeLocalConfig(path, { ...current, port });
}
