import { cfg } from "../config.js";
import { qd } from "../qdrant.js";
import { deleteById } from "../storage.js";
import { storeMemory, colForType } from "../util.js";
import type { MemoryType, ScopeType } from "../types.js";

export interface ConsolidateArgs {
  source:               string;
  target:               string;
  similarity_threshold: number;
  dry_run:              boolean;
}

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

export async function consolidateTool(a: ConsolidateArgs): Promise<string> {
  const srcCol = colForType(a.source);

  const { points } = await qd.scroll(srcCol, {
    filter: {
      must: [{ key: "project_id", match: { value: cfg.projectId } }],
    },
    limit:        500,
    with_vector: true,
    with_payload: true,
  });

  if (points.length === 0) return "no records to consolidate.";

  const used = new Set<number>();
  const clusters: number[][] = [];

  for (let i = 0; i < points.length; i++) {
    if (used.has(i)) continue;
    const cluster = [i];
    used.add(i);

    const v1 = points[i]!.vector as number[];

    for (let j = i + 1; j < points.length; j++) {
      if (used.has(j)) continue;
      const v2  = points[j]!.vector as number[];
      const sim = dotProduct(v1, v2);
      if (sim >= a.similarity_threshold) {
        cluster.push(j);
        used.add(j);
      }
    }

    if (cluster.length > 1) clusters.push(cluster);
  }

  if (clusters.length === 0) return "no groups to merge (everything is unique).";

  const lines = [`Found ${clusters.length} groups:\n`];
  let mergedTotal = 0;

  for (let ci = 0; ci < clusters.length; ci++) {
    const cluster = clusters[ci]!;
    const p = (pt: (typeof points)[number]) =>
      (pt.payload ?? {}) as Record<string, unknown>;

    lines.push(`  Group ${ci + 1} (${cluster.length} records):`);
    for (const idx of cluster) {
      lines.push(`    - ${String(p(points[idx]!)["content"] ?? "").slice(0, 100)}`);
    }

    if (!a.dry_run) {
      const fullContents = cluster.map((idx) =>
        String(p(points[idx]!)["content"] ?? "")
      );
      const combined = fullContents.join(" | ");
      const maxImp = cluster.reduce((m, idx) => {
        const imp = Number(p(points[idx]!)["importance"] ?? 0.5);
        return Math.max(m, imp);
      }, 0);

      await storeMemory({
        content:    `[Consolidated] ${combined}`,
        memoryType: a.target as MemoryType,
        scope:      "project" as ScopeType,
        tags:       "consolidated",
        importance: Math.min(maxImp + 0.1, 1.0),
        ttlHours:   0,
      });

      const ids = cluster.map((idx) => String(points[idx]!.id));
      await qd.delete(srcCol, { points: ids });
      for (const id of ids) {
        await deleteById(id);
      }
      mergedTotal += cluster.length;
    }
  }

  if (!a.dry_run) {
    lines.push(`\nMerged ${mergedTotal} records into ${clusters.length} clusters`);
  } else {
    lines.push(`\nDry run. Call consolidate(dry_run=false) to execute.`);
  }

  return lines.join("\n");
}
