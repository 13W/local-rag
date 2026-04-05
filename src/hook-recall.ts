import { cfg } from "./config.js";
import { qd, colName } from "./qdrant.js";
import { embedOne } from "./embedder.js";
import { debugLog } from "./util.js";
import type { Status } from "./types.js";

const TOP_K         = 5;
const MIN_SCORE     = 0.6;
const PER_COL_LIMIT = 10;
const MAX_CHARS     = 2000; // ≈ 500 tokens

interface HookInput {
  session_id:      string;
  transcript_path: string;
  cwd:             string;
  hook_event_name: string;
  prompt:          string;
}

/** Higher = shown first. */
const STATUS_PRIORITY: Record<Status, number> = {
  in_progress:   2,
  open_question: 2,
  hypothesis:    1,
  resolved:      0,
};

interface Hit {
  score:   number;
  text:    string;
  status:  Status;
  confidence: number;
  created_at: string;
  content_hash: string;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end",  ()      => resolve(buf));
  });
}

function formatMessage(hits: Hit[]): string {
  if (hits.length === 0) {
    return "No prior context found for this topic. This is new territory.";
  }

  const lines = ["Relevant memory:"];
  for (const h of hits) {
    const date = h.created_at ? h.created_at.slice(0, 10) : "unknown";
    lines.push(`  [${h.status}] ${h.text}`);
    lines.push(`    confidence: ${h.confidence.toFixed(2)} | ${date}`);
  }

  const msg = lines.join("\n");
  return msg.length > MAX_CHARS ? msg.slice(0, MAX_CHARS - 1) + "…" : msg;
}

export async function runHookRecall(): Promise<void> {
  try {
    const raw   = await readStdin();
    const input = JSON.parse(raw.trim() || "{}") as Partial<HookInput>;
    const prompt = (input.prompt ?? "").trim();

    if (!prompt) {
      process.stdout.write('{"systemMessage":""}\n');
      return;
    }
    debugLog("hook-recall", `prompt="${prompt.slice(0, 100)}"`);
    debugLog("hook-recall", `searching collections: ${colName("memory")} ${colName("memory_agents")} threshold=${MIN_SCORE} limit=${PER_COL_LIMIT}`);

    const vector = await embedOne(prompt);

    const mustFilter = [{ key: "project_id", match: { value: cfg.projectId } }];

    type QHit = Awaited<ReturnType<typeof qd.search>>[number];

    // When debug logging is on, search without score_threshold to see near-misses.
    const debugMode = !!cfg.debugLogPath;
    const [memHits, agentHits] = await Promise.all([
      qd.search(colName("memory"), {
        vector:          vector,
        filter:          { must: mustFilter },
        limit:           PER_COL_LIMIT,
        with_payload:    true,
        ...(debugMode ? {} : { score_threshold: MIN_SCORE }),
      }).catch((): QHit[] => []),
      qd.search(colName("memory_agents"), {
        vector:          vector,
        filter:          { must: mustFilter },
        limit:           PER_COL_LIMIT,
        with_payload:    true,
        ...(debugMode ? {} : { score_threshold: MIN_SCORE }),
      }).catch((): QHit[] => []),
    ]);

    if (debugMode) {
      for (const h of memHits) {
        const p = (h.payload ?? {}) as Record<string, unknown>;
        const text = String(p["text"] ?? p["content"] ?? "").slice(0, 80);
        debugLog("hook-recall", `  memory  score=${h.score.toFixed(3)} ${h.score >= MIN_SCORE ? "PASS" : "FAIL(<" + MIN_SCORE + ")"} "${text}"`);
      }
      for (const h of agentHits) {
        const p = (h.payload ?? {}) as Record<string, unknown>;
        const text = String(p["text"] ?? p["content"] ?? "").slice(0, 80);
        debugLog("hook-recall", `  agents  score=${h.score.toFixed(3)} ${h.score >= MIN_SCORE ? "PASS" : "FAIL(<" + MIN_SCORE + ")"} "${text}"`);
      }
    }

    // Merge, deduplicate by content_hash, convert to typed hits.
    const seen = new Set<string>();
    const hits: Hit[] = [];

    for (const raw of [...memHits, ...agentHits]) {
      if (raw.score < MIN_SCORE) continue; // manual filter when debug mode bypassed score_threshold
      const p    = (raw.payload ?? {}) as Record<string, unknown>;
      const hash = String(p["content_hash"] ?? raw.id);
      if (seen.has(hash)) continue;
      seen.add(hash);

      const status = (p["status"] ?? "resolved") as Status;
      hits.push({
        score:        raw.score,
        text:         String(p["text"] ?? ""),
        status,
        confidence:   Number(p["confidence"] ?? raw.score),
        created_at:   String(p["created_at"] ?? ""),
        content_hash: hash,
      });
    }

    debugLog("hook-recall", `memHits=${memHits.length} agentHits=${agentHits.length} merged=${hits.length}`);

    // Sort: priority DESC, then score DESC.
    hits.sort((a, b) => {
      const pd = (STATUS_PRIORITY[b.status] ?? 0) - (STATUS_PRIORITY[a.status] ?? 0);
      return pd !== 0 ? pd : b.score - a.score;
    });

    const top = hits.slice(0, TOP_K);
    for (const h of top) {
      debugLog("hook-recall", `hit score=${h.score.toFixed(3)} status=${h.status} text="${h.text.slice(0, 80)}"`);
    }
    const systemMessage = formatMessage(top);

    process.stdout.write(JSON.stringify({ systemMessage }) + "\n");
  } catch {
    process.stdout.write('{"systemMessage":""}\n');
  }
}
