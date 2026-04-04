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
  branches?:      string[];
}

export interface StoreMemoryParams {
  content:    string;
  memoryType: MemoryType;
  scope:      ScopeType;
  tags:       string;
  importance: number;
  ttlHours:   number;
}

// ── New memory schema (specification.md) ──────────────────────────────────────

export type Status      = "in_progress" | "resolved" | "open_question" | "hypothesis";
export type SessionType = "planning" | "editing" | "headless" | "multi_agent";

/** Canonical payload for `memory` and `memory_agents` collections. */
export interface MemoryEntryPayload {
  text:         string;        // raw content (distinct from legacy "content" field)
  status:       Status;
  session_id:   string;        // Claude Code session_id from hook input
  session_type: SessionType;
  created_at:   string;        // ISO 8601
  updated_at:   string;        // ISO 8601
  resolved_at:  string | null; // ISO 8601 or null
  confidence:   number;        // 0.0–1.0 (router score)
  source:       string;        // e.g. "hook-remember:stop" | "hook-remember:session_end"
  project_id:   string;
  agent_id:     string;
  content_hash: string;        // SHA-256 first 16 hex chars, dedup key
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
