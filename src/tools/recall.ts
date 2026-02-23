import { cfg } from "../config.js";
import { qd } from "../qdrant.js";
import { incrementAccess } from "../redis.js";
import { embedOne, llmFilter, type Candidate } from "../embedder.js";
import { finalScore } from "../scoring.js";
import { colForType, nowIso } from "../util.js";

export interface RecallArgs {
  query:         string;
  memory_type:   string;
  scope:         string;
  tags:          string;
  limit:         number;
  min_relevance: number;
  time_decay:    boolean;
  llm_filter:    boolean;
}

export async function recallTool(a: RecallArgs): Promise<string> {
  const embedding = await embedOne(a.query);

  const collections: string[] =
    a.memory_type === "episodic" ||
    a.memory_type === "semantic" ||
    a.memory_type === "procedural"
      ? [colForType(a.memory_type)]
      : ["memory_episodic", "memory_semantic", "memory_procedural"];

  const mustFilters: Array<{ key: string; match: { value: string } }> = [
    { key: "project_id", match: { value: cfg.projectId } },
  ];
  if (a.scope) {
    mustFilters.push({ key: "scope", match: { value: a.scope } });
  }

  const perColLimit = Math.min(a.limit * 2, 30);

  // Search each collection; silently ignore collection-level failures.
  type Hit = Awaited<ReturnType<typeof qd.search>>[number];
  const colSearches = collections.map((col) =>
    qd
      .search(col, {
        vector:           embedding,
        filter:           { must: mustFilters },
        limit:            perColLimit,
        with_payload:     true,
        score_threshold:  a.min_relevance,
      })
      .catch((): Hit[] => [])
  );

  const colResults = await Promise.all(colSearches);

  const reqTags = a.tags
    ? new Set(a.tags.split(",").map((t) => t.trim()).filter(Boolean))
    : null;

  const now = nowIso();
  const results: Candidate[] = [];

  for (let ci = 0; ci < collections.length; ci++) {
    const col  = collections[ci]!;
    const hits = colResults[ci]!;
    const mt   = col.replace("memory_", "");

    for (const hit of hits) {
      const p         = (hit.payload ?? {}) as Record<string, unknown>;
      const createdAt = String(p["created_at"] ?? "");
      const importance = Number(p["importance"] ?? 0.5);
      const score     = finalScore(hit.score, createdAt, importance, a.time_decay);

      if (reqTags) {
        const memTags = new Set(
          Array.isArray(p["tags"]) ? (p["tags"] as string[]) : []
        );
        let overlap = false;
        for (const t of reqTags) { if (memTags.has(t)) { overlap = true; break; } }
        if (!overlap) continue;
      }

      if (score < a.min_relevance) continue;

      // Fire-and-forget; never let Redis errors surface as tool failures.
      incrementAccess(String(hit.id), cfg.projectId, mt, now).catch(() => undefined);

      const tagStr = Array.isArray(p["tags"])
        ? (p["tags"] as string[]).map((t) => `#${t}`).join(" ")
        : "";

      results.push([score, mt, hit.id, String(p["content"] ?? ""), tagStr, createdAt.slice(0, 10)]);
    }
  }

  results.sort((a, b) => b[0] - a[0]);
  let limited = results.slice(0, a.limit);

  if (a.llm_filter && limited.length > 0) {
    limited = await llmFilter(a.query, limited).catch(() => limited);
  }

  if (limited.length === 0) return "nothing found.";

  const lines = [`Found ${limited.length} memories:\n`];
  for (const [score, mt, mid, content, tagsS, date] of limited) {
    lines.push(`[${score.toFixed(2)}] [${mt}] ${content.slice(0, 200)}`);
    lines.push(`  ${tagsS}  |  ${mid}  |  ${date}`);
    lines.push("");
  }
  return lines.join("\n");
}
