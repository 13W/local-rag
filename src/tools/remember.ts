import { storeMemory } from "../util.js";
import type { MemoryType, ScopeType } from "../types.js";

export interface RememberArgs {
  content:     string;
  memory_type: string;
  scope:       string;
  tags:        string;
  importance:  number;
  ttl_hours:   number;
}

export async function rememberTool(a: RememberArgs): Promise<string> {
  return storeMemory({
    content:    a.content,
    memoryType: a.memory_type as MemoryType,
    scope:      a.scope       as ScopeType,
    tags:       a.tags,
    importance: a.importance,
    ttlHours:   a.ttl_hours,
  });
}
