import { createHash } from "node:crypto";
import type { StoreMemoryParams } from "./types.js";
import { cfg } from "./config.js";
import { qd, colName } from "./qdrant.js";
import { embedOne } from "./embedder.js";

export function colForType(memoryType: string): string {
  return colName(`memory_${memoryType}`);
}

export function contentHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function storeMemory(params: StoreMemoryParams): Promise<string> {
  const { content, memoryType, scope, tags, importance, ttlHours } = params;

  if (!["episodic", "semantic", "procedural"].includes(memoryType)) {
    return "error: memory_type must be: episodic, semantic, procedural";
  }

  const colName = colForType(memoryType);
  const hash = contentHash(content);

  const { points: existing } = await qd.scroll(colName, {
    filter: {
      must: [
        { key: "content_hash", match: { value: hash } },
        { key: "project_id",   match: { value: cfg.projectId } },
      ],
    },
    limit: 1,
  });
  if (existing.length > 0) {
    return `already exists: ${existing[0]!.id}`;
  }

  const memId  = crypto.randomUUID();
  const now    = nowIso();
  const tagList = tags
    ? tags.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  const expiresAt = ttlHours > 0
    ? new Date(Date.now() + ttlHours * 3_600_000).toISOString()
    : "";

  const embedding = await embedOne(content);

  await qd.upsert(colName, {
    points: [
      {
        id:      memId,
        vector:  embedding,
        payload: {
          content,
          agent_id:     cfg.agentId,
          project_id:   cfg.projectId,
          memory_type:  memoryType,
          scope,
          importance,
          access_count: 0,
          tags:         tagList,
          content_hash: hash,
          created_at:   now,
          updated_at:   now,
          expires_at:   expiresAt,
        },
      },
    ],
  });

  return `stored [${memoryType}]: ${memId} (importance=${importance})`;
}
