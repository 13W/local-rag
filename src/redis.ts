/**
 * Redis metadata store — replaces SQLite.
 *
 * Key schema:
 *   mem:{id}                → Hash  (all metadata fields)
 *   proj:{projectId}:top    → Sorted Set  (score = access_count, member = "{id}#{memoryType}")
 *
 * The sorted set makes topAccessed O(log N) for writes and O(K) for reads.
 */

import { Redis } from "ioredis";
import { cfg } from "./config.js";

export const redis = new Redis(cfg.redisUrl, {
  lazyConnect: false,
  retryStrategy: (times: number) => Math.min(times * 1000, 10_000),
});

redis.on("error", (err: Error) => {
  process.stderr.write(`[redis] ${err.message}\n`);
});

// ── key helpers ─────────────────────────────────────────────────────────────

function memKey(id: string): string {
  return `mem:${id}`;
}

function topKey(projectId: string): string {
  return `proj:${projectId}:top`;
}

function memberStr(id: string, memoryType: string): string {
  return `${id}#${memoryType}`;
}

// ── public interface ─────────────────────────────────────────────────────────

export interface InsertMetaParams {
  id:         string;
  agentId:    string;
  projectId:  string;
  memoryType: string;
  scope:      string;
  importance: number;
  createdAt:  string;
  expiresAt:  string | null;
  tags:       string;
  contentHash: string;
}

/** Store metadata for a newly created memory. */
export async function insertMeta(p: InsertMetaParams): Promise<void> {
  const pipe = redis.pipeline();
  pipe.hset(memKey(p.id), {
    agent_id:     p.agentId,
    project_id:   p.projectId,
    memory_type:  p.memoryType,
    scope:        p.scope,
    importance:   String(p.importance),
    access_count: "0",
    created_at:   p.createdAt,
    updated_at:   p.createdAt,
    expires_at:   p.expiresAt ?? "",
    tags:         p.tags,
    content_hash: p.contentHash,
  });
  pipe.zadd(topKey(p.projectId), "0", memberStr(p.id, p.memoryType));
  if (p.expiresAt) {
    const unixSec = Math.floor(new Date(p.expiresAt).getTime() / 1000);
    pipe.expireat(memKey(p.id), unixSec);
  }
  await pipe.exec();
}

/** Returns { memoryType, projectId } or null when the key doesn't exist. */
export async function getMemoryMeta(
  id: string
): Promise<{ memoryType: string; projectId: string } | null> {
  const [memoryType, projectId] = await redis.hmget(
    memKey(id),
    "memory_type",
    "project_id"
  );
  if (!memoryType || !projectId) return null;
  return { memoryType, projectId };
}

/**
 * Delete a memory's metadata from both the hash and the sorted set.
 * Looks up projectId + memoryType internally so callers only need the id.
 */
export async function deleteById(id: string): Promise<void> {
  const meta = await getMemoryMeta(id);
  const pipe = redis.pipeline();
  pipe.del(memKey(id));
  if (meta) {
    pipe.zrem(topKey(meta.projectId), memberStr(id, meta.memoryType));
  }
  await pipe.exec();
}

/**
 * Increment access_count for a memory and update the sorted set score.
 * Callers (recall tool) already know projectId and memoryType, so we skip
 * the extra HMGET round-trip.
 */
export async function incrementAccess(
  id: string,
  projectId: string,
  memoryType: string,
  now: string
): Promise<void> {
  const pipe = redis.pipeline();
  pipe.hincrby(memKey(id), "access_count", 1);
  pipe.hset(memKey(id), "updated_at", now);
  pipe.zincrby(topKey(projectId), 1, memberStr(id, memoryType));
  await pipe.exec();
}

export interface TopAccessedEntry {
  id:          string;
  memoryType:  string;
  accessCount: number;
}

/** Return the top 5 most-accessed memories for a project. */
export async function topAccessed(projectId: string): Promise<TopAccessedEntry[]> {
  // ZREVRANGE returns flat [member, score, member, score, ...]
  const raw = await redis.zrevrange(topKey(projectId), 0, 4, "WITHSCORES");
  const entries: TopAccessedEntry[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const member = raw[i];
    const score  = raw[i + 1];
    if (!member || score === undefined) continue;
    const sep = member.indexOf("#");
    if (sep === -1) continue;
    entries.push({
      id:          member.slice(0, sep),
      memoryType:  member.slice(sep + 1),
      accessCount: Number(score),
    });
  }
  return entries;
}
