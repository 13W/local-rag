export interface ToolStats {
  calls:     number;
  bytesIn:   number;
  bytesOut:  number;
  totalMs:   number;
  errors:    number;
  avgMs:     number;
  tokensEst: number;
}

export interface RequestEntry {
  ts:       number;
  tool:     string;
  source:   "mcp" | "playground" | "watcher";
  bytesIn:  number;
  bytesOut: number;
  ms:       number;
  ok:       boolean;
  chunks?:  number;
  error?:   string;
}

export interface PropSchema {
  type?:        string;
  description?: string;
  default?:     unknown;
  enum?:        unknown[];
}

export interface ToolSchemaDef {
  name:         string;
  description?: string;
  inputSchema: {
    properties: Record<string, PropSchema>;
    required:   string[];
  };
}

export interface ServerInfo {
  projectId:            string;
  agentId:              string;
  version:              string;
  watch:                boolean;
  branch:               string;
  collectionPrefix:     string;
  embedProvider:        string;
  embedModel:           string;
  llmProvider:          string;
  llmModel:             string;
  generateDescriptions: boolean;
}

export interface ProcessError {
  message: string;
  stack:   string;
  ts:      number;
}

export interface ReindexProgress {
  total:  number;
  done:   number;
  chunks: number;
}

export interface MemoryEntry {
  id:           string;
  text:         string;
  status:       string;
  confidence:   number;
  session_id:   string;
  session_type: string;
  updated_at:   string;
  created_at:   string;
}

export interface SessionEntry {
  session_id:    string;
  count:         number;
  dominant_type: string;
  latest:        string;
}

export interface OverviewData {
  statusCounts: Record<string, number>;
  recent:       MemoryEntry[];
  sessions:     SessionEntry[];
}

export interface InitData {
  stats:      Record<string, ToolStats>;
  log:        RequestEntry[];
  schemas:    ToolSchemaDef[];
  serverInfo: ServerInfo;
  projects:   ProjectConfigData[];
}

export interface EmbedConfigData {
  provider: string;
  model:    string;
  api_key:  string;
  dim:      number;
  url:      string;
}

export interface LlmConfigData {
  provider: string;
  model:    string;
  api_key:  string;
  url:      string;
  fallback: LlmConfigData | null;
}

export interface ServerConfigData {
  embed:             EmbedConfigData;
  llm:               LlmConfigData;
  router:            LlmConfigData;
  collection_prefix: string;
  port:              number;
  updated_at:        string;
}

export interface ProjectConfigData {
  project_id:    string;
  display_name:  string;
  agent_id:      string;
  project_root:  string;
  include_paths: string[];
  indexer_state: string;
  created_at:    string;
  updated_at:    string;
}
