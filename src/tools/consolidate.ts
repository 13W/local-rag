import { cfg, getProjectId } from "../config.js";
import { qd } from "../qdrant.js";
import { deleteById } from "../storage.js";
import { storeMemory, colForType } from "../util.js";
import type { MemoryType, ScopeType } from "../types.js";
import { callLlmSimple, defaultRouterSpec } from "../llm-client.js";
import { debugLog } from "../util.js";

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

const SYNTHESIS_PROMPT = 
  "You are a memory consolidation system for an AI agent. Your goal is to synthesize multiple similar memories into a single, high-value insight or experience entry.\n\n" +
  "GOALS:\n" +
  "1. IDENTIFY PATTERNS: If multiple entries describe similar problems or behaviors, formulate a general rule or pattern.\n" +
  "2. CAPTURE OBSERVATIONS: If entries contain subtle technical nuances, ensure they are preserved.\n" +
  "3. CLEANUP: Remove duplicates, outdated details, and conversational filler.\n" +
  "4. STAND-ALONE TEXT: The resulting text must be clear and descriptive.\n\n" +
  "CRITICAL: Do NOT use placeholders like '...' or literal choices like 'observation|resolved'. Provide ACTUAL synthesized content.\n\n" +
  "OUTPUT FORMAT:\n" +
  "Output JSON only: { \"text\": \"Actual synthesized text here\", \"status\": \"one_of_the_statuses\" }\n" +
  "Valid statuses: observation, resolved, in_progress\n\n" +
  "Input memories to synthesize:\n";

export async function consolidateTool(a: ConsolidateArgs): Promise<string> {
  const srcCol = colForType(a.source);
  const projectId = getProjectId();

  debugLog("consolidate", `Consolidating from collection: ${srcCol}`);

  const { points } = await qd.scroll(srcCol, {
    filter: {
      must: [{ key: "project_id", match: { value: projectId } }],
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

  const lines = [`Found ${clusters.length} groups to synthesize:\\n`];
  let mergedTotal = 0;

  for (let ci = 0; ci < clusters.length; ci++) {
    const cluster = clusters[ci]!;
    const p = (pt: (typeof points)[number]) =>
      (pt.payload ?? {}) as Record<string, unknown>;

    lines.push(`  Group ${ci + 1} (${cluster.length} records):`);
    for (const idx of cluster) {
      lines.push(`    - ${String(p(points[idx]!)["content"] ?? p(points[idx]!)["text"] ?? "").slice(0, 100)}`);
    }

    if (!a.dry_run) {
      const fullContents = cluster.map((idx) =>
        String(p(points[idx]!)["content"] ?? p(points[idx]!)["text"] ?? "")
      );
      
      const prompt = SYNTHESIS_PROMPT + fullContents.map(c => `- ${c}`).join("\n");
      const spec = cfg.routerConfig ?? defaultRouterSpec();
      
      debugLog("consolidate", `Synthesizing group ${ci + 1} with ${cluster.length} items...`);
      
      let synthesizedText = "";
      let synthesizedStatus: string | undefined;

      try {
        const raw = await callLlmSimple(prompt, spec);
        const match = raw.match(/\{[\s\S]*?\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          synthesizedText = String(parsed.text || "").trim();
          synthesizedStatus = String(parsed.status || "");
        } else {
          synthesizedText = raw.trim();
        }
      } catch (err) {
        debugLog("consolidate", `Synthesis failed, falling back to simple join: ${String(err)}`);
        synthesizedText = `[Consolidated] ` + fullContents.join(" | ");
      }

      if (!synthesizedText || synthesizedText === "...") {
        synthesizedText = `[Consolidated] ` + fullContents.join(" | ");
      }
      
      // Sanitize status (ensure it's not the placeholder string)
      if (synthesizedStatus && (synthesizedStatus.includes("|") || !["observation", "resolved", "in_progress"].includes(synthesizedStatus))) {
        synthesizedStatus = undefined;
      }

      const maxImp = cluster.reduce((m, idx) => {
        const imp = Number(p(points[idx]!)["importance"] ?? 0.5);
        return Math.max(m, imp);
      }, 0);

      // Find the latest session info from the cluster
      let latestSid = "";
      let latestStype = "headless";
      let latestTs = "";
      for (const idx of cluster) {
        const pt = points[idx]!;
        const sid = String(p(pt)["session_id"] ?? "");
        const ts = String(p(pt)["updated_at"] ?? p(pt)["created_at"] ?? "");
        if (ts > latestTs) {
          latestTs = ts;
          if (sid) latestSid = sid;
          latestStype = String(p(pt)["session_type"] ?? "headless");
        }
      }

      // Determine the best tag/type
      const tags = cluster.flatMap(idx => {
        const t = p(points[idx]!)["tags"];
        return Array.isArray(t) ? t : [];
      });
      const uniqueTags = Array.from(new Set([...tags, "synthesized"]));

      await storeMemory({
        content:    synthesizedText,
        memoryType: a.target as MemoryType,
        scope:      "project" as ScopeType,
        status:     (synthesizedStatus as any) || (a.target === "semantic" || a.target === "memory" ? "resolved" : "observation"),
        tags:       uniqueTags.join(","),
        importance: Math.min(maxImp + 0.1, 1.0),
        ttlHours:   0,
        sessionId:  latestSid,
        sessionType: latestStype,
        source:     "consolidate",
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
    lines.push(`\\nSynthesized ${mergedTotal} records into ${clusters.length} new insights.`);
  } else {
    lines.push(`\\nDry run. Call consolidate(dry_run=false) to execute.`);
  }

  return lines.join("\n");
}
