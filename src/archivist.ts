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

import { cfg, type RouterProviderSpec } from "./config.js";
import { qd, colName } from "./qdrant.js";
import { embedOne } from "./embedder.js";
import { callLlmSimple, callLlmWithTools, type ToolDef } from "./llm-client.js";
import { debugLog } from "./util.js";

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

const SEARCH_MEMORY_TOOL: ToolDef = {
  name: "search_memory",
  description:
    "Search project memory for relevant context. " +
    "Call this to find facts, decisions, open questions, and work-in-progress. " +
    "Reformulate the query in English for best semantic match.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query in English, optimised for semantic similarity.",
      },
      collections: {
        type: "array",
        items: { type: "string" },
        description: "Collections to search. Options: memory, episodic, semantic, procedural. Omit to search all.",
      },
      status: {
        type: "string",
        enum: ["in_progress", "resolved", "open_question", "hypothesis", ""],
        description: "Filter by entry status. Omit for no filter.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Filter by tags.",
      },
      limit: {
        type: "integer",
        description: "Maximum results to return. Default 10.",
      },
    },
    required: ["query"],
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function _defaultSpec(): RouterProviderSpec {
  return {
    provider: cfg.llmProvider as RouterProviderSpec["provider"],
    model:    cfg.llmModel,
    api_key:  cfg.llmApiKey || undefined,
    url:      cfg.llmUrl    || undefined,
  };
}

// ── Project profile ───────────────────────────────────────────────────────────

async function _loadProfile(): Promise<ProjectProfile | null> {
  type ScrollPt = { payload?: Record<string, unknown> };
  const { points } = await qd.scroll(colName("memory"), {
    filter: {
      must: [
        { key: "project_id", match: { value: cfg.projectId } },
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
async function _profilePointId(): Promise<string> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(`profile:${cfg.projectId}`).digest("hex");
  // Format as UUID v4-shaped string (Qdrant requires UUID format)
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
}

/**
 * Build and cache a project profile in Qdrant.
 * No-op if a fresh profile (< 24h) already exists.
 */
export async function buildProjectProfile(): Promise<void> {
  const cached = await _loadProfile();
  if (cached) {
    process.stderr.write(`[archivist] profile cached (built ${cached.builtAt})\n`);
    debugLog("archivist", `profile cached builtAt=${cached.builtAt}`);
    return;
  }

  type ScrollPt = { payload?: Record<string, unknown> };
  const collectionBases = ["memory", "memory_episodic", "memory_semantic"];
  const samples: string[]                 = [];
  const tagCounts: Record<string, number> = {};
  const stats: Record<string, number>     = {};

  for (const base of collectionBases) {
    const col = colName(base);
    const { points } = await qd.scroll(col, {
      filter:       { must: [{ key: "project_id", match: { value: cfg.projectId } }] },
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

  const spec = cfg.routerConfig ?? _defaultSpec();
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
    projectId: cfg.projectId,
    builtAt:   new Date().toISOString(),
    topTags,
    topTopics,
    collectionStats: stats,
  };

  // Deterministic ID so upsert overwrites the existing profile point.
  const profileId = await _profilePointId();
  const vector = await embedOne(topTopics.join(" "));
  await qd.upsert(colName("memory"), {
    points: [{
      id:      profileId,
      vector,
      payload: { _type: PROFILE_TYPE, project_id: cfg.projectId, ...profile },
    }],
  });

  process.stderr.write(`[archivist] profile built: topics=[${topTopics.slice(0, 5).join(", ")}] tags=${topTags.length}\n`);
  debugLog("archivist", `profile built topics=${topTopics.length} tags=${topTags.length}`);
}

// ── System prompt ─────────────────────────────────────────────────────────────

function _buildSystemPrompt(profile: ProjectProfile | null): string {
  if (!profile) {
    return (
      "You are a memory archivist. " +
      "Use the search_memory tool to find relevant context for the user's query. " +
      "If nothing relevant is found, return an empty string."
    );
  }
  return [
    `You are a memory archivist for project "${profile.projectId}".`,
    `Key topics: ${profile.topTopics.join(", ")}.`,
    `Common tags: ${profile.topTags.slice(0, 15).join(", ")}.`,
    `Collections: ${Object.entries(profile.collectionStats).map(([c, n]) => `${c}(${n})`).join(", ")}.`,
    "",
    "Use search_memory to find context relevant to the user's query.",
    "Reformulate queries in English for best semantic match.",
    "Return a concise summary of relevant findings.",
    "If nothing relevant is found, return an empty string.",
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
    { key: "project_id", match: { value: cfg.projectId } },
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
    const filter: Record<string, unknown> = { must: mustFilter };
    if (tags.length > 0) {
      filter["should"] = tags.map(t => ({ key: "tags", match: { value: t } }));
    }
    const hits = await qd.search(col, {
      vector,
      filter: filter as Parameters<typeof qd.search>[1]["filter"],
      limit,
      with_payload:    true,
      score_threshold: 0.3,
    }).catch((): QHit[] => []);
    allHits.push(...hits);
  }));

  allHits.sort((a, b) => b.score - a.score);
  const top = allHits.slice(0, limit);

  debugLog("archivist", `search results=${top.length}`);

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
 * Returns a systemMessage string (may be empty if nothing relevant found).
 * Never throws.
 */
export async function runArchivist(prompt: string): Promise<string> {
  debugLog("archivist", `prompt="${prompt.slice(0, 100)}"`);

  const profile = await _loadProfile().catch(() => null);
  debugLog("archivist", `profile=${profile ? "loaded" : "missing"}`);

  const systemPrompt = _buildSystemPrompt(profile);
  const spec         = cfg.routerConfig ?? _defaultSpec();

  try {
    const result = await callLlmWithTools(
      prompt,
      systemPrompt,
      [SEARCH_MEMORY_TOOL],
      (_name, args) => _executeSearchMemory(args),
      spec,
    );
    debugLog("archivist", `response len=${result.length}`);
    return result;
  } catch (err: unknown) {
    process.stderr.write(`[archivist] failed: ${String(err)}\n`);
    debugLog("archivist", `error: ${String(err)}`);
    return "";
  }
}
