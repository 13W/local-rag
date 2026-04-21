/**
 * Archivist — LLM-powered memory retrieval.
 *
 * buildProjectProfile(): call once at server startup to cache a project profile
 *   in Qdrant (key topics, tags, collection stats). TTL: 24h.
 *
 * runArchivist(prompt): called by hook-recall on each user prompt.
 *   Loads the cached profile, calls the LLM with a search_memory tool,
 *   executes the search, returns the LLM's final text to inject as systemMessage.
 */

import { cfg, getProjectId } from "./config.js";
import { qd, colName } from "./qdrant.js";
import { embedOne } from "./embedder.js";
import { callLlmSimple, callLlmTool, defaultRouterSpec, type ToolDef } from "./llm-client.js";
import { debugLog } from "./util.js";
import { createHash } from "node:crypto";

// ── Constants ─────────────────────────────────────────────────────────────────

const PROFILE_TYPE  = "project-profile";
const PROFILE_TTL_H = 24;

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProjectProfile {
  projectId:       string;
  builtAt:         string;
  topTags:         string[];
  topTopics:       string[];
  collectionStats: Record<string, number>;
}

// ── Tool definition ───────────────────────────────────────────────────────────

const EXTRACT_QUERY_TOOL: ToolDef = {
  name: "extract_query",
  description: "Extract a concise semantic search query from the user's message.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Short English search query (max 10 words) optimised for semantic similarity.",
      },
    },
    required: ["query"],
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Project profile ───────────────────────────────────────────────────────────

async function _loadProfile(): Promise<ProjectProfile | null> {
  const projectId = getProjectId();
  type ScrollPt = { payload?: Record<string, unknown> };
  const { points } = await qd.scroll(colName("memory"), {
    filter: {
      must: [
        { key: "project_id", match: { value: projectId } },
        { key: "_type",      match: { value: PROFILE_TYPE } },
      ],
    },
    limit: 1,
    with_payload: true,
  }).catch(() => ({ points: [] as ScrollPt[] }));

  if (!points.length) return null;

  const p       = ((points[0] as ScrollPt).payload ?? {});
  const builtAt = String(p["builtAt"] ?? "");
  if (!builtAt) return null;

  const ageMs = Date.now() - new Date(builtAt).getTime();
  if (ageMs > PROFILE_TTL_H * 3_600_000) return null;

  return {
    projectId:       String(p["projectId"] ?? ""),
    builtAt,
    topTags:         Array.isArray(p["topTags"])   ? (p["topTags"]   as string[]) : [],
    topTopics:       Array.isArray(p["topTopics"]) ? (p["topTopics"] as string[]) : [],
    collectionStats: (typeof p["collectionStats"] === "object" && p["collectionStats"] !== null)
      ? (p["collectionStats"] as Record<string, number>)
      : {},
  };
}

/** Stable UUID-shaped ID for this project's profile point (same projectId → same ID). */
function _profilePointId(): string {
  const hash = createHash("sha256").update(`profile:${getProjectId()}`).digest("hex");
  // Format as UUID v4-shaped string (Qdrant requires UUID format)
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
}

/**
 * Build and cache a project profile in Qdrant.
 * No-op if a fresh profile (< 24h) already exists.
 */
export async function buildProjectProfile(): Promise<void> {
  const projectId = getProjectId();
  const cached = await _loadProfile();
  if (cached) {
    process.stderr.write(`[archivist] profile cached (built ${cached.builtAt})\n`);
    debugLog("archivist", `profile cached builtAt=${cached.builtAt}`);
    return;
  }

  type ScrollPt = { payload?: Record<string, unknown> };
  const collectionBases = ["memory", "memory_episodic", "memory_semantic", "memory_procedural"];
  const samples: string[]                 = [];
  const tagCounts: Record<string, number> = {};
  const stats: Record<string, number>     = {};

  for (const base of collectionBases) {
    const col = colName(base);
    const { points } = await qd.scroll(col, {
      filter:       { must: [{ key: "project_id", match: { value: projectId } }] },
      limit:        15,
      with_payload: true,
    }).catch(() => ({ points: [] as ScrollPt[] }));

    stats[col] = points.length;

    for (const pt of points as ScrollPt[]) {
      const payload = pt.payload ?? {};
      const text    = String(payload["text"] ?? payload["content"] ?? "").trim().slice(0, 200);
      if (text) samples.push(text);
      const tags = Array.isArray(payload["tags"]) ? payload["tags"] as string[] : [];
      for (const t of tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
    }
  }

  if (samples.length === 0) {
    process.stderr.write(`[archivist] no samples found — skipping profile build\n`);
    return;
  }

  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([t]) => t);

  let topTopics: string[] = topTags.slice(0, 10);

  const spec = cfg.routerConfig ?? defaultRouterSpec();
  const topicsPrompt =
    "Extract 10 key topics and domain terms from these project memory entries.\n" +
    "Output a JSON array of strings only. No explanation.\n\n" +
    samples.join("\n---\n");
  try {
    const raw   = await callLlmSimple(topicsPrompt, spec);
    const match = raw.match(/\[[\s\S]*?\]/);
    if (match) topTopics = JSON.parse(match[0]) as string[];
  } catch (err: unknown) {
    process.stderr.write(`[archivist] topic extraction failed: ${String(err)}\n`);
  }

  const profile: ProjectProfile = {
    projectId,
    builtAt:   new Date().toISOString(),
    topTags,
    topTopics,
    collectionStats: stats,
  };

  // Deterministic ID so upsert overwrites the existing profile point.
  const profileId = _profilePointId();
  const vector = await embedOne(topTopics.join(" "));
  await qd.upsert(colName("memory"), {
    points: [{
      id:      profileId,
      vector,
      payload: { _type: PROFILE_TYPE, project_id: projectId, ...profile },
    }],
  });

  process.stderr.write(`[archivist] profile built: topics=[${topTopics.slice(0, 5).join(", ")}] tags=${topTags.length}\n`);
  debugLog("archivist", `profile built topics=${topTopics.length} tags=${topTags.length}`);
}

// ── System prompt ─────────────────────────────────────────────────────────────

function _buildQueryPrompt(profile: ProjectProfile | null, prompt: string): string {
  const profileCtx = profile ? [
    `Project topics: ${profile.topTopics.join(", ")}.`,
    `Common tags: ${profile.topTags.slice(0, 15).join(", ")}.`,
  ].join("\n") : "";

  return [
    profileCtx,
    "",
    `Given the following message, produce ONE concise English search query (max 10 words) to retrieve relevant project memory entries.`,
    `Return ONLY the query string — no explanation, no punctuation around it.`,
    "",
    `Message: ${prompt}`,
  ].join("\n");
}

// ── Tool executor ─────────────────────────────────────────────────────────────

async function _executeSearchMemory(args: Record<string, unknown>): Promise<string> {
  const query    = String(args["query"] ?? "").trim();
  const colBases = (Array.isArray(args["collections"]) && (args["collections"] as string[]).length > 0)
    ? (args["collections"] as string[])
    : ["memory", "episodic", "semantic", "procedural"];
  const status   = String(args["status"] ?? "");
  const limit    = Math.min(Number(args["limit"] ?? 10), 20);

  debugLog("archivist", `tool_call search_memory query="${query.slice(0, 80)}" cols=[${colBases.join(",")}] status=${status}`);

  if (!query) return JSON.stringify({ results: [] });

  const vector = await embedOne(query);

  const mustFilter: Array<{ key: string; match: { value: string } }> = [
    { key: "project_id", match: { value: getProjectId() } },
  ];
  if (status) mustFilter.push({ key: "status", match: { value: status } });

  const tags = Array.isArray(args["tags"]) ? (args["tags"] as string[]).filter(Boolean) : [];

  // Strip any accidental "memory_" prefix the model may have added, then normalise.
  const collections = colBases.map(b => {
    const base = b.replace(/^memory_/, "");
    return colName(base === "memory" ? "memory" : `memory_${base}`);
  });

  type QHit = Awaited<ReturnType<typeof qd.search>>[number];
  const allHits: QHit[] = [];

  await Promise.all(collections.map(async col => {
    const effectiveMust: unknown[] = [...mustFilter];
    if (tags.length > 0) {
      // Nested should inside must: "must match at least one tag"
      effectiveMust.push({ should: tags.map(t => ({ key: "tags", match: { value: t } })) });
    }
    const hits = await qd.search(col, {
      vector,
      filter: { must: effectiveMust } as Parameters<typeof qd.search>[1]["filter"],
      limit,
      with_payload:    true,
      score_threshold: 0.3,
    }).catch((): QHit[] => []);
    allHits.push(...hits);
  }));

  allHits.sort((a, b) => b.score - a.score);
  const top = allHits.slice(0, limit);

  if (top.length > 0) {
    const summary = top.map(h => {
      const p = (h.payload ?? {}) as Record<string, unknown>;
      const text = String(p["text"] ?? p["content"] ?? "").replace(/\n/g, " ").slice(0, 60);
      return `[${h.score.toFixed(2)}] ${text}`;
    }).join(" | ");
    debugLog("archivist", `search results=${top.length} summary="${summary}"`);
  } else {
    debugLog("archivist", "search results=0");
  }

  if (top.length === 0) return JSON.stringify({ results: [] });

  return JSON.stringify({
    results: top.map(h => {
      const p = (h.payload ?? {}) as Record<string, unknown>;
      return {
        text:   String(p["text"] ?? p["content"] ?? "").slice(0, 500),
        score:  h.score.toFixed(3),
        status: String(p["status"] ?? ""),
        tags:   Array.isArray(p["tags"]) ? p["tags"] : [],
      };
    }),
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the archivist for a user prompt.
 * Returns a plain-text bulleted list of relevant memory entries, or "".
 * Never throws.
 */
export async function runArchivist(prompt: string): Promise<string> {
  const currentMsgMatch = prompt.match(/\n\nCurrent message: (.*)$/s);
  const currentMsg = currentMsgMatch ? currentMsgMatch[1] : prompt;
  debugLog("archivist", `prompt_preview="${currentMsg.slice(0, 150).replace(/\n/g, " ")}"`);

  const profile = await _loadProfile().catch(() => null);
  debugLog("archivist", `profile=${profile ? "loaded" : "missing"}`);

  const spec = cfg.routerConfig ?? defaultRouterSpec();

  try {
    // Step 1: ask LLM only to extract a search query — no narrative output
    const queryPrompt = _buildQueryPrompt(profile, currentMsg);
    let searchQuery: string;
    try {
      const toolArgs = await callLlmTool(queryPrompt, EXTRACT_QUERY_TOOL, spec);
      searchQuery = String(toolArgs?.["query"] ?? "").trim();
    } catch {
      // Fallback: use the raw message as the query
      searchQuery = currentMsg.slice(0, 100);
    }
    if (!searchQuery) return "";

    debugLog("archivist", `search_query="${searchQuery}"`);

    // Step 2: run the search directly — no LLM involved in formatting
    const rawResults = await _executeSearchMemory({ query: searchQuery, limit: 8 });
    const parsed = JSON.parse(rawResults) as { results: { text: string; score: string; status: string; tags: string[] }[] };
    if (!parsed.results.length) return "";

    // Step 3: format deterministically — no LLM, no chance of injection
    const bullets = parsed.results.map(r => {
      const snippet = r.text.replace(/\n/g, " ").trim();
      const status  = r.status ? ` [${r.status}]` : "";
      return `• ${snippet}${status}`;
    });

    const result = bullets.join("\n");
    debugLog("archivist", `response bullets=${bullets.length} len=${result.length}`);
    return result;
  } catch (err: unknown) {
    process.stderr.write(`[archivist] failed: ${String(err)}\n`);
    debugLog("archivist", `error: ${String(err)}`);
    return "";
  }
}
