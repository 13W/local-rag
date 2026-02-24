import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

// pnpm passes its own "--" separator into process.argv when using
// `pnpm <script> -- <args>`.  Strip it so that named options that follow
// are not silently treated as positionals by parseArgs.
const rawArgs = process.argv.slice(2).filter((a) => a !== "--");

const { values } = parseArgs({
  args: rawArgs,
  options: {
    "config":                { type: "string",  short: "c" },
    "qdrant-url":            { type: "string" },
    "ollama-url":            { type: "string" },
    "embed-model":           { type: "string" },
    "embed-dim":             { type: "string" },
    "agent-id":              { type: "string" },
    "project-id":            { type: "string" },
    "llm-model":             { type: "string" },
    "project-root":          { type: "string" },
    "generate-descriptions": { type: "boolean" },
  },
  allowPositionals: true,
  strict: false,
});

type ConfigFile = Partial<{
  "qdrant-url":             string;
  "ollama-url":             string;
  "embed-model":            string;
  "embed-dim":              string | number;
  "agent-id":               string;
  "project-id":             string;
  "llm-model":              string;
  "project-root":           string;
  "generate-descriptions":  boolean;
  "include-paths":          string[];
}>;

let file: ConfigFile = {};
let configDir: string | undefined;
const configPath = values["config"] as string | undefined;
if (configPath) {
  const abs = resolve(configPath);
  if (!existsSync(abs)) {
    process.stderr.write(`[config] Config file not found: ${abs}\n`);
    process.exit(1);
  }
  file      = JSON.parse(readFileSync(abs, "utf8")) as ConfigFile;
  configDir = dirname(abs);
}

function str(key: keyof ConfigFile & string, fallback: string): string {
  if (values[key] !== undefined) return values[key] as string;
  if (file[key]   !== undefined) return String(file[key]);
  return fallback;
}

function bool(key: keyof ConfigFile & string, fallback: boolean): boolean {
  if (values[key] !== undefined) return values[key] as boolean;
  if (file[key]   !== undefined) return Boolean(file[key]);
  return fallback;
}

export const cfg = Object.freeze({
  qdrantUrl:            str("qdrant-url",   "http://localhost:6333"),
  ollamaUrl:            str("ollama-url",   "http://localhost:11434"),
  embedModel:           str("embed-model",  "mxbai-embed-large"),
  embedDim:             parseInt(str("embed-dim", "1024"), 10),
  agentId:              str("agent-id",     "default"),
  projectId:            str("project-id",   "default"),
  llmModel:             str("llm-model",    "gemma3n:e2b"),
  projectRoot:          str("project-root", configDir ?? ""),
  generateDescriptions: bool("generate-descriptions", false),
  includePaths:         (file["include-paths"] ?? []) as string[],
});
process.stderr.write(
  `[config] projectId=${cfg.projectId} projectRoot=${cfg.projectRoot || "(cwd)"} includePaths=${cfg.includePaths.length}\n`
);
