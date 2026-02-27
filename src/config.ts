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
    "embed-provider":        { type: "string" },
    "embed-api-key":         { type: "string" },
    "embed-url":             { type: "string" },
    "llm-provider":          { type: "string" },
    "llm-api-key":           { type: "string" },
    "llm-url":               { type: "string" },
    "dashboard":             { type: "boolean" },
    "dashboard-port":        { type: "string" },
    "collection-prefix":     { type: "string" },
    "no-watch":              { type: "boolean" },
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
  "embed-provider":         string;
  "embed-api-key":          string;
  "embed-url":              string;
  "llm-provider":           string;
  "llm-api-key":            string;
  "llm-url":                string;
  "dashboard-port"?:        string | number;
  "dashboard"?:             boolean;
  "collection-prefix"?:     string;
  "no-watch"?:              boolean;
}>;

let file: ConfigFile = {};
let configDir: string | undefined;
const configPath = values["config"] as string | undefined;
const { INIT_CWD, PWD } = process.env;
const workingDirectory = INIT_CWD || PWD || process.cwd()

const resolvedConfigPath = configPath ??
  (existsSync(resolve(workingDirectory, ".memory.json")) ? ".memory.json" : undefined);

if (resolvedConfigPath) {
  const abs = resolve(workingDirectory, resolvedConfigPath);
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

const embedProvider = str("embed-provider", "ollama") as "ollama" | "openai" | "voyage";
const llmProvider   = str("llm-provider",   "ollama") as "ollama" | "anthropic" | "openai";

const embedApiKeyEnv = embedProvider === "openai"    ? process.env.OPENAI_API_KEY
                     : embedProvider === "voyage"    ? process.env.VOYAGE_API_KEY
                     : undefined;
const llmApiKeyEnv   = llmProvider   === "anthropic" ? process.env.ANTHROPIC_API_KEY
                     : llmProvider   === "openai"    ? process.env.OPENAI_API_KEY
                     : undefined;

const EMBED_MODEL_DEFAULT: Record<string, string> = {
  ollama:  "embeddinggemma:300m",
  openai:  "text-embedding-3-small",
  voyage:  "voyage-code-3",
};
const LLM_MODEL_DEFAULT: Record<string, string> = {
  ollama:    "gemma3n:e2b",
  anthropic: "claude-haiku-4-5-20251001",
  openai:    "gpt-4o-mini",
};

export const cfg = Object.freeze({
  qdrantUrl:            str("qdrant-url",   "http://localhost:6333"),
  ollamaUrl:            str("ollama-url",   "http://localhost:11434"),
  embedModel:           str("embed-model",  EMBED_MODEL_DEFAULT[embedProvider] ?? "embeddinggemma:300m"),
  embedDim:             parseInt(str("embed-dim", "768"), 10),
  embedProvider,
  embedApiKey:          str("embed-api-key",  embedApiKeyEnv ?? ""),
  embedUrl:             str("embed-url",       ""),
  agentId:              str("agent-id",     "default"),
  projectId:            str("project-id",   "default"),
  llmModel:             str("llm-model",    LLM_MODEL_DEFAULT[llmProvider] ?? "gemma3n:e2b"),
  llmProvider,
  llmApiKey:            str("llm-api-key",  llmApiKeyEnv ?? ""),
  llmUrl:               str("llm-url",       ""),
  projectRoot:          str("project-root", configDir ?? ""),
  generateDescriptions: bool("generate-descriptions", false),
  includePaths:         (file["include-paths"] ?? []) as string[],
  dashboardPort:        parseInt(str("dashboard-port", "0"), 10),
  dashboard:            bool("dashboard", true),
  collectionPrefix:     str("collection-prefix", ""),
  watch:                !bool("no-watch", false),
});
process.stderr.write(
  `[config] projectId=${cfg.projectId} projectRoot=${cfg.projectRoot || "(cwd)"} includePaths=${cfg.includePaths.length}\n`
);
