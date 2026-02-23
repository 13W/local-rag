export type MemoryType = "episodic" | "semantic" | "procedural";
export type ScopeType  = "agent" | "project" | "global";

export interface MemoryPayload {
  content:      string;
  agent_id:     string;
  project_id:   string;
  scope:        string;
  importance:   number;
  tags:         string[];
  content_hash: string;
  created_at:   string;
}

export interface CodeChunkPayload {
  content:        string;
  file_path:      string;
  chunk_type:     string;
  name:           string;
  signature:      string;
  start_line:     number;
  end_line:       number;
  language:       string;
  jsdoc:          string;
  project_id:     string;
  file_hash?:     string;
  description?:   string;
  parent_id?:     string;
  children_ids?:  string[];
  is_parent?:     boolean;
  imports?:       string[];
}

export interface StoreMemoryParams {
  content:    string;
  memoryType: MemoryType;
  scope:      ScopeType;
  tags:       string;
  importance: number;
  ttlHours:   number;
}

export interface CodeChunk {
  content:    string;
  filePath:   string;
  chunkType:  string;
  name:       string;
  signature:  string;
  startLine:  number;
  endLine:    number;
  language:   string;
  jsdoc:      string;
  imports?:   string[];
  /** "parent" = large container that recurses into children; "child" = lives inside a parent */
  chunkRole?: "parent" | "child" | "regular";
  /** "{filePath}:{startLine}" of the enclosing parent chunk */
  parentKey?: string;
}
