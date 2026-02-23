/**
 * Redis metadata store — replaces SQLite.
 *
 * Key schema:
 *   mem:{id}                        → Hash  (all metadata fields)
 *   proj:{projectId}:top            → Sorted Set  (score = access_count, member = "{id}#{memoryType}")
 *   dep:{projectId}:{filePath}      → String (JSON array of resolved import paths)
 *   dep-rev:{projectId}:{filePath}  → Set    (files that import this file)
 *   project:{projectId}:overview    → String (cached project overview JSON)
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

function depKey(projectId: string, filePath: string): string {
  return `dep:${projectId}:${filePath}`;
}

function depRevKey(projectId: string, filePath: string): string {
  return `dep-rev:${projectId}:${filePath}`;
}

function overviewKey(projectId: string): string {
  return `project:${projectId}:overview`;
}

// ── public interface — memory ─────────────────────────────────────────────────

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

// ── public interface — dependency graph ───────────────────────────────────────

/**
 * Store the resolved imports for a file, replacing any existing entries.
 * Also maintains the reverse-dependency index.
 */
export async function setDeps(
  projectId: string,
  filePath:  string,
  imports:   string[]
): Promise<void> {
  const oldRaw = await redis.get(depKey(projectId, filePath));
  const oldImports: string[] = oldRaw ? (JSON.parse(oldRaw) as string[]) : [];

  const pipe = redis.pipeline();

  // Remove stale reverse-dep entries
  for (const old of oldImports) {
    pipe.srem(depRevKey(projectId, old), filePath);
  }

  // Set new forward deps
  if (imports.length > 0) {
    pipe.set(depKey(projectId, filePath), JSON.stringify(imports));
  } else {
    pipe.del(depKey(projectId, filePath));
  }

  // Add new reverse-dep entries
  for (const imp of imports) {
    pipe.sadd(depRevKey(projectId, imp), filePath);
  }

  await pipe.exec();
}

/** Get the direct imports of a file (forward deps). */
export async function getDeps(projectId: string, filePath: string): Promise<string[]> {
  const raw = await redis.get(depKey(projectId, filePath));
  return raw ? (JSON.parse(raw) as string[]) : [];
}

/** Get files that directly import this file (reverse deps). */
export async function getReverseDeps(projectId: string, filePath: string): Promise<string[]> {
  return redis.smembers(depRevKey(projectId, filePath));
}

/** Recursively collect all transitive dependencies up to `depth` levels. */
export async function getTransitiveDeps(
  projectId: string,
  filePath:  string,
  depth:     number,
  direction: "imports" | "imported_by" = "imports"
): Promise<Map<string, number>> {
  const visited = new Map<string, number>(); // filePath → depth at which found
  const queue: Array<{ path: string; level: number }> = [{ path: filePath, level: 0 }];

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.level >= depth) continue;
    if (visited.has(item.path)) continue;
    visited.set(item.path, item.level);

    const next =
      direction === "imports"
        ? await getDeps(projectId, item.path)
        : await getReverseDeps(projectId, item.path);

    for (const n of next) {
      if (!visited.has(n)) {
        queue.push({ path: n, level: item.level + 1 });
      }
    }
  }

  // Remove the root file itself
  visited.delete(filePath);
  return visited;
}

/** Remove dependency records for a file (called on file deletion). */
export async function clearDeps(projectId: string, filePath: string): Promise<void> {
  await setDeps(projectId, filePath, []);
}

// ── public interface — project overview cache ─────────────────────────────────

/** Cache the project overview string (invalidated on structural changes). */
export async function setProjectOverview(projectId: string, overview: string): Promise<void> {
  await redis.set(overviewKey(projectId), overview);
}

/** Get cached project overview, or null if not cached. */
export async function getProjectOverview(projectId: string): Promise<string | null> {
  return redis.get(overviewKey(projectId));
}

/** Invalidate the cached overview (call when files are added/deleted). */
export async function invalidateProjectOverview(projectId: string): Promise<void> {
  await redis.del(overviewKey(projectId));
}

/**
 * Return the top N files by reverse-dependency count (most imported = most central).
 * Uses SCARD on dep-rev keys.
 */
export async function topFilesByRevDeps(
  projectId: string,
  filePaths: string[],
  limit: number
): Promise<Array<{ filePath: string; count: number }>> {
  if (filePaths.length === 0) return [];

  const pipe = redis.pipeline();
  for (const fp of filePaths) {
    pipe.scard(depRevKey(projectId, fp));
  }
  const results = await pipe.exec();

  const entries = filePaths.map((fp, i) => {
    const res = results?.[i];
    const count = res && res[0] === null ? Number(res[1]) : 0;
    return { filePath: fp, count };
  });

  return entries
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
