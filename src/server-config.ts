import type { QdrantClient } from "@qdrant/js-client-rest";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LlmProviderConfig {
  provider:     "ollama" | "anthropic" | "openai" | "gemini";
  model:        string;
  api_key:      string;
  url:          string;
  timeout:      number;
  max_attempts: number;
  fallback:     LlmProviderConfig | null;
}

export interface EmbedConfig {
  provider:     "ollama" | "openai" | "voyage";
  model:        string;
  api_key:      string;
  dim:          number;
  url:          string;
  timeout:      number;
  max_attempts: number;
}

export interface ServerConfig {
  embed:             EmbedConfig;
  llm:               LlmProviderConfig;
  router:            LlmProviderConfig;
  collection_prefix: string;
  port:              number;
  updated_at:        string;
}

export type IndexerState = "running" | "paused" | "stopped";

export interface ProjectConfig {
  project_id:    string;
  display_name:  string;
  agent_id:      string;
  project_root:  string;
  include_paths: string[];
  indexer_state: IndexerState;
  created_at:    string;
  updated_at:    string;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_LLM: LlmProviderConfig = {
  provider: "ollama", model: "gemma3n:e2b", api_key: "", url: "",
  timeout: 120, max_attempts: 3, fallback: null,
};

const DEFAULT_EMBED: EmbedConfig = {
  provider: "ollama", model: "embeddinggemma:300m", api_key: "", dim: 768, url: "",
  timeout: 120, max_attempts: 3,
};

export function mergeServerConfig(raw: Partial<ServerConfig>): ServerConfig {
  return {
    embed:             { ...DEFAULT_EMBED,  ...(raw.embed  ?? {}) },
    llm:               { ...DEFAULT_LLM,   ...(raw.llm    ?? {}) },
    router:            { ...DEFAULT_LLM,   ...(raw.router ?? {}) },
    collection_prefix: raw.collection_prefix ?? "",
    port:              raw.port ?? 7531,
    updated_at:        raw.updated_at ?? new Date().toISOString(),
  };
}

export function mergeProjectConfig(raw: Partial<ProjectConfig> & { project_id: string }): ProjectConfig {
  const now = new Date().toISOString();
  return {
    project_id:    raw.project_id,
    display_name:  raw.display_name  ?? raw.project_id,
    agent_id:      raw.agent_id      ?? raw.project_id,
    project_root:  raw.project_root  ?? "",
    include_paths: raw.include_paths ?? [],
    indexer_state: raw.indexer_state ?? "stopped",
    created_at:    raw.created_at    ?? now,
    updated_at:    raw.updated_at    ?? now,
  };
}

// ── Qdrant CRUD ───────────────────────────────────────────────────────────────

const SERVER_CONFIG_COL = "server_config";
const PROJECTS_COL      = "projects";
const SERVER_CONFIG_ID  = 1;

export async function ensureConfigCollections(qd: QdrantClient): Promise<void> {
  const cols = await qd.getCollections().then(r => new Set(r.collections.map(c => c.name)));
  if (!cols.has(SERVER_CONFIG_COL)) {
    await qd.createCollection(SERVER_CONFIG_COL, { vectors: { size: 1, distance: "Cosine" } });
  }
  if (!cols.has(PROJECTS_COL)) {
    await qd.createCollection(PROJECTS_COL, { vectors: { size: 1, distance: "Cosine" } });
  }
}

export async function loadServerConfig(qd: QdrantClient): Promise<ServerConfig> {
  const result = await qd.retrieve(SERVER_CONFIG_COL, {
    ids: [SERVER_CONFIG_ID], with_payload: true, with_vector: false,
  }).catch(() => []);
  const raw = (result[0]?.payload ?? {}) as Partial<ServerConfig>;
  return mergeServerConfig(raw);
}

export async function saveServerConfig(qd: QdrantClient, cfg: ServerConfig): Promise<void> {
  await qd.upsert(SERVER_CONFIG_COL, {
    wait: true,
    points: [{ id: SERVER_CONFIG_ID, vector: [0], payload: { ...cfg, updated_at: new Date().toISOString() } }],
  });
}

export async function loadProjectConfig(qd: QdrantClient, projectId: string): Promise<ProjectConfig | null> {
  const result = await qd.scroll(PROJECTS_COL, {
    filter: { must: [{ key: "project_id", match: { value: projectId } }] },
    limit: 1, with_payload: true, with_vector: false,
  }).catch(() => ({ points: [] as { payload?: Record<string, unknown> }[] }));
  const pt = result.points[0];
  if (!pt) return null;
  return mergeProjectConfig({ ...(pt.payload as Partial<ProjectConfig>), project_id: projectId });
}

export async function upsertProjectConfig(qd: QdrantClient, proj: ProjectConfig): Promise<void> {
  // 1. Try to find existing point ID for this project_id
  const result = await qd.scroll(PROJECTS_COL, {
    filter: { must: [{ key: "project_id", match: { value: proj.project_id } }] },
    limit: 1, with_payload: false,
  }).catch(() => ({ points: [] as { id: string | number }[] }));

  // 2. Use existing ID if found, otherwise generate a deterministic numeric hash ID
  const id = result.points[0]?.id ??
    (Math.abs(proj.project_id.split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)) || 1);

  await qd.upsert(PROJECTS_COL, {
    wait: true,
    points: [{ id, vector: [0], payload: { ...proj, updated_at: new Date().toISOString() } }],
  });
}

export async function listProjectConfigs(qd: QdrantClient): Promise<ProjectConfig[]> {
  const result = await qd.scroll(PROJECTS_COL, {
    limit: 100, with_payload: true, with_vector: false,
  }).catch(() => ({ points: [] as { payload?: Record<string, unknown> }[] }));
  return result.points.map(pt => mergeProjectConfig({
    ...(pt.payload as Partial<ProjectConfig>),
    project_id: String((pt.payload as Record<string, unknown>)["project_id"] ?? ""),
  }));
}
