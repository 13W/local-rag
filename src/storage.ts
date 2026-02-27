/**
 * Qdrant-backed storage — drop-in replacement for redis.ts.
 * All function signatures are identical so consumers only change their import path.
 */

import { qd, colName } from "./qdrant.js";

const MEMORY_COLLECTIONS = [
  "memory_episodic",
  "memory_semantic",
  "memory_procedural",
] as const;

// ── public interface — memory ─────────────────────────────────────────────────

export interface InsertMetaParams {
  id:          string;
  agentId:     string;
  projectId:   string;
  memoryType:  string;
  scope:       string;
  importance:  number;
  createdAt:   string;
  expiresAt:   string | null;
  tags:        string;
  contentHash: string;
}

/** No-op: all fields are now written by storeMemory() directly to Qdrant payload. */
export async function insertMeta(_p: InsertMetaParams): Promise<void> {}

/** Returns { memoryType, projectId } or null when the point doesn't exist in any collection. */
export async function getMemoryMeta(
  id: string
): Promise<{ memoryType: string; projectId: string } | null> {
  const searches = MEMORY_COLLECTIONS.map((col) =>
    qd
      .retrieve(colName(col), { ids: [id], with_payload: ["memory_type", "project_id"] })
      .then((pts) => ({ col, pts }))
      .catch(() => ({ col, pts: [] as unknown[] }))
  );

  const results = await Promise.all(searches);

  for (const { col, pts } of results) {
    const pt = (pts as Array<{ id: string | number; payload?: Record<string, unknown> | null }>)[0];
    if (!pt) continue;
    const payload    = (pt.payload ?? {}) as Record<string, unknown>;
    const projectId  = typeof payload["project_id"]  === "string" ? payload["project_id"]  : null;
    // Fall back to deriving memoryType from base collection name for pre-migration points.
    const memoryType = typeof payload["memory_type"] === "string"
      ? payload["memory_type"]
      : col.replace("memory_", "");
    if (!projectId) continue;
    return { memoryType, projectId };
  }

  return null;
}

/**
 * No-op: the Qdrant point deletion is handled by callers (forget / consolidate).
 * There is no separate metadata record to clean up.
 */
export async function deleteById(_id: string): Promise<void> {}

export interface TopAccessedEntry {
  id:          string;
  memoryType:  string;
  accessCount: number;
}

/**
 * Increment access_count for a memory by reading the current value from Qdrant
 * and writing back an incremented value via setPayload.
 * Fire-and-forget: callers must .catch(() => undefined) if they want to suppress errors.
 */
export async function incrementAccess(
  id:          string,
  _projectId:  string,
  _memoryType: string,
  now:         string
): Promise<void> {
  const searches = MEMORY_COLLECTIONS.map((col) =>
    qd
      .retrieve(colName(col), { ids: [id], with_payload: ["access_count"] })
      .then((pts) => ({ col, pts }))
      .catch(() => ({ col, pts: [] as unknown[] }))
  );

  const results = await Promise.all(searches);

  for (const { col, pts } of results) {
    const pt = (pts as Array<{ id: string | number; payload?: Record<string, unknown> | null }>)[0];
    if (!pt) continue;
    const payload     = (pt.payload ?? {}) as Record<string, unknown>;
    const accessCount = Number(payload["access_count"] ?? 0) + 1;
    await qd.setPayload(colName(col), {
      payload: { access_count: accessCount, updated_at: now },
      points:  [id],
    });
    return;
  }
}

/** Return the top 5 most-accessed memories for a project (in-memory sort). */
export async function topAccessed(projectId: string): Promise<TopAccessedEntry[]> {
  const entries: TopAccessedEntry[] = [];

  for (const col of MEMORY_COLLECTIONS) {
    const memType = col.replace("memory_", "");
    let offset: string | number | undefined;

    while (true) {
      const result = await qd
        .scroll(colName(col), {
          filter: { must: [{ key: "project_id", match: { value: projectId } }] },
          limit:        500,
          with_payload: ["access_count"],
          with_vector:  false,
          ...(offset !== undefined && { offset }),
        })
        .catch((): { points: []; next_page_offset: undefined } => ({
          points: [],
          next_page_offset: undefined,
        }));

      for (const pt of result.points) {
        const payload     = (pt.payload ?? {}) as Record<string, unknown>;
        const accessCount = Number(payload["access_count"] ?? 0);
        if (accessCount > 0) {
          entries.push({ id: String(pt.id), memoryType: memType, accessCount });
        }
      }

      const next = (result as { next_page_offset?: string | number | null }).next_page_offset;
      if (!next) break;
      offset = next;
    }
  }

  return entries
    .sort((a, b) => b.accessCount - a.accessCount)
    .slice(0, 5);
}

// ── public interface — dependency graph ───────────────────────────────────────

/**
 * No-op: imports are written to Qdrant by the indexer as part of chunk upsert.
 * The `imports` field on code_chunks serves as the forward-dep store.
 */
export async function setDeps(
  _projectId: string,
  _filePath:  string,
  _imports:   string[]
): Promise<void> {}

/** Get the direct imports of a file (forward deps) from code_chunks payload. */
export async function getDeps(projectId: string, filePath: string): Promise<string[]> {
  const result = await qd
    .scroll(colName("code_chunks"), {
      filter: {
        must: [
          { key: "project_id", match: { value: projectId } },
          { key: "file_path",  match: { value: filePath  } },
        ],
      },
      limit:        1,
      with_payload: ["imports"],
      with_vector:  false,
    })
    .catch((): { points: [] } => ({ points: [] }));

  const pt = result.points[0];
  if (!pt) return [];
  const payload = (pt.payload ?? {}) as Record<string, unknown>;
  const imports = payload["imports"];
  return Array.isArray(imports) ? (imports as string[]) : [];
}

/** Get files that directly import this file (reverse deps). */
export async function getReverseDeps(projectId: string, filePath: string): Promise<string[]> {
  const seen = new Set<string>();
  let offset: string | number | undefined;

  while (true) {
    const result = await qd
      .scroll(colName("code_chunks"), {
        filter: {
          must: [
            { key: "project_id", match: { value: projectId } },
            { key: "imports",    match: { value: filePath  } },
          ],
        },
        limit:        500,
        with_payload: ["file_path"],
        with_vector:  false,
        ...(offset !== undefined && { offset }),
      })
      .catch((): { points: []; next_page_offset: undefined } => ({
        points: [],
        next_page_offset: undefined,
      }));

    for (const pt of result.points) {
      const payload = (pt.payload ?? {}) as Record<string, unknown>;
      const fp = payload["file_path"];
      if (typeof fp === "string") seen.add(fp);
    }

    const next = (result as { next_page_offset?: string | number | null }).next_page_offset;
    if (!next) break;
    offset = next;
  }

  return [...seen];
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

  visited.delete(filePath);
  return visited;
}

/**
 * No-op: old chunks (including their imports field) are deleted by the indexer
 * before re-indexing a file, so there is nothing extra to clear.
 */
export async function clearDeps(_projectId: string, _filePath: string): Promise<void> {}

// ── public interface — project overview cache ─────────────────────────────────

/** No-op: project overview is always recomputed; caching is removed. */
export async function setProjectOverview(
  _projectId: string,
  _overview:  string
): Promise<void> {}

/** Always returns null so the caller falls through to recompute. */
export async function getProjectOverview(_projectId: string): Promise<string | null> {
  return null;
}

/** No-op: caching is disabled. */
export async function invalidateProjectOverview(_projectId: string): Promise<void> {}

/**
 * Return the top N files by reverse-dependency count.
 * Scrolls all code_chunks once and builds an in-memory frequency map from imports arrays.
 */
export async function topFilesByRevDeps(
  projectId: string,
  filePaths: string[],
  limit:     number
): Promise<Array<{ filePath: string; count: number }>> {
  if (filePaths.length === 0) return [];

  const pathSet = new Set(filePaths);
  const counts  = new Map<string, number>();
  let offset: string | number | undefined;

  while (true) {
    const result = await qd
      .scroll(colName("code_chunks"), {
        filter: { must: [{ key: "project_id", match: { value: projectId } }] },
        limit:        500,
        with_payload: ["imports"],
        with_vector:  false,
        ...(offset !== undefined && { offset }),
      })
      .catch((): { points: []; next_page_offset: undefined } => ({
        points: [],
        next_page_offset: undefined,
      }));

    for (const pt of result.points) {
      const payload = (pt.payload ?? {}) as Record<string, unknown>;
      const imports = payload["imports"];
      if (!Array.isArray(imports)) continue;
      for (const imp of imports as string[]) {
        if (pathSet.has(imp)) {
          counts.set(imp, (counts.get(imp) ?? 0) + 1);
        }
      }
    }

    const next = (result as { next_page_offset?: string | number | null }).next_page_offset;
    if (!next) break;
    offset = next;
  }

  return filePaths
    .map((fp) => ({ filePath: fp, count: counts.get(fp) ?? 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

