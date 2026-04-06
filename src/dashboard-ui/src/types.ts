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
  ts:        number;
  tool:      string;
  source:    "mcp" | "playground" | "watcher" | "hook";
  bytesIn:   number;
  bytesOut:  number;
  ms:        number;
  ok:        boolean;
  chunks?:   number;
  error?:    string;
  // hook-only
  hook_type?:  "recall" | "remember";
  session_id?: string;
  project_id?: string;
  agent_id?:   string;
  found?:      number;
  summary?:    string;
  written?:    number;
  validated?:  number;
  discarded?:  number;
  facts?:      string[];
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

export interface InitData {
  stats:      Record<string, ToolStats>;
  log:        RequestEntry[];
  schemas:    ToolSchemaDef[];
  serverInfo: ServerInfo;
}
