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
  generateDescriptions: boolean;
}

export interface ProcessError {
  message: string;
  stack:   string;
  ts:      number;
}

export interface InitData {
  stats:      Record<string, ToolStats>;
  log:        RequestEntry[];
  schemas:    ToolSchemaDef[];
  serverInfo: ServerInfo;
}
