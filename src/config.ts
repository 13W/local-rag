import type { ServerConfig } from "./server-config.js";
import { getProjectId } from "./request-context.js";
import { setCollectionPrefix, setEmbedDim } from "./qdrant.js";
import { applyRateLimits } from "./llm-client.js";

// Re-export for backward compat — tools can import these from config.js
export { getProjectId };

// ── RouterProviderSpec ────────────────────────────────────────────────────────

export interface RouterProviderSpec {
  provider:     "ollama" | "anthropic" | "openai" | "gemini";
  model:        string;
  api_key?:     string;
  url?:         string;
  timeout?:     number;
  max_attempts?: number;
  max_tokens?:  number;
  fallback?:    RouterProviderSpec | null;
}

// ── Runtime config ────────────────────────────────────────────────────────────

interface RuntimeConfig {
  qdrantUrl:            string;
  embedProvider:        "ollama" | "openai" | "voyage" | "gemini";
  embedModel:           string;
  embedApiKey:          string;
  embedDim:             number;
  embedUrl:             string;
  embedMaxChars:        number;
  embedTimeout:         number;
  embedMaxAttempts:     number;
  ollamaUrl:            string;
  llmProvider:          "ollama" | "anthropic" | "openai" | "gemini";
  llmModel:             string;
  llmApiKey:            string;
  llmUrl:               string;
  llmTimeout:           number;
  llmMaxAttempts:       number;
  routerConfig:         RouterProviderSpec | null;
  collectionPrefix:     string;
  port:                 number;
  projectId:            string;
  debugLogPath:         string;
  generateDescriptions: boolean;
  projectDir:           string;
  includePaths:         string[];
  dashboard:            boolean;
  dashboardPort:        number;
}

// Mutable — populated by applyServerConfig() at server startup.
// Tools read this at call time (after startup), so values are always current.
export const cfg: RuntimeConfig = {
  qdrantUrl:            "http://localhost:6333",
  embedProvider:        "ollama",
  embedModel:           "embeddinggemma:300m",
  embedApiKey:          "",
  embedDim:             768,
  embedUrl:             "",
  embedMaxChars:        3000,
  embedTimeout:         120,
  embedMaxAttempts:     3,
  ollamaUrl:            "http://localhost:11434",
  llmProvider:          "ollama",
  llmModel:             "gemma3n:e2b",
  llmApiKey:            "",
  llmUrl:               "",
  llmTimeout:           120,
  llmMaxAttempts:       3,
  routerConfig:         null,
  collectionPrefix:     "",
  port:                 7531,
  projectId:            "default",
  debugLogPath:         process.env["MEMORY_DEBUG_LOG"] ?? "",
  generateDescriptions: true,
  projectDir:           "",
  includePaths:         [],
  dashboard:            true,
  dashboardPort:        0,
};

/** Called at server startup after loading ServerConfig from Qdrant. */
export function applyServerConfig(sc: ServerConfig, projectId?: string): void {
  cfg.embedProvider    = sc.embed.provider as RuntimeConfig["embedProvider"];
  cfg.embedModel       = sc.embed.model;
  cfg.embedApiKey      = sc.embed.api_key;
  cfg.embedDim         = sc.embed.dim;
  cfg.embedUrl         = sc.embed.url;
  cfg.embedMaxChars    = sc.embed.max_chars;
  cfg.embedTimeout     = sc.embed.timeout;
  cfg.embedMaxAttempts = sc.embed.max_attempts;
  cfg.llmProvider      = sc.llm.provider as RuntimeConfig["llmProvider"];
  cfg.llmModel         = sc.llm.model;
  cfg.llmApiKey        = sc.llm.api_key;
  cfg.llmUrl           = sc.llm.url;
  cfg.llmTimeout       = sc.llm.timeout;
  cfg.llmMaxAttempts   = sc.llm.max_attempts;
  cfg.routerConfig     = sc.router as RouterProviderSpec;
  cfg.collectionPrefix = sc.collection_prefix;
  cfg.port             = sc.port;
  if (projectId) cfg.projectId = projectId;
  // Propagate to qdrant module
  setCollectionPrefix(sc.collection_prefix);
  setEmbedDim(sc.embed.dim);
  // Apply per-model rate limits
  applyRateLimits(sc.rate_limits ?? {});
}

/** Mutable current branch — updated by watcher on branch switch. */
let _currentBranch = "default";
export function setCurrentBranch(branch: string): void { _currentBranch = branch; }
export function getCurrentBranchCached(): string { return _currentBranch; }
