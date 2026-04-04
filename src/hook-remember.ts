import { readFileSync, existsSync } from "node:fs";
import { cfg } from "./config.js";
import { qd, colName } from "./qdrant.js";
import { embedOne } from "./embedder.js";
import { contentHash, nowIso } from "./util.js";
import { runRouter, type RouterOp } from "./router.js";
import type { SessionType } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const WINDOW_CHARS      = 8_000;  // ≈ 2000 tokens at 4 chars/token
const SIMILARITY_THRESH = 0.88;   // cosine threshold to recognise an existing entry

const CONFIDENCE_THRESH: Record<SessionType, number> = {
  planning:    0.75,
  editing:     0.75,
  headless:    0.85,
  multi_agent: 0.80,
};

const EDIT_TOOLS = new Set(["Write", "Edit", "Bash", "MultiEdit", "NotebookEdit"]);

// ── Session detection ─────────────────────────────────────────────────────────

interface SessionDetection {
  sessionType: SessionType;
  agentId:     string;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface HookInput {
  session_id:        string;
  transcript_path:   string;
  cwd:               string;
  hook_event_name:   string;
  stop_hook_active?: boolean;
}

// ── Transcript parsing ────────────────────────────────────────────────────────

type JsonLine = Record<string, unknown>;

function safeParseLines(raw: string): JsonLine[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line) as JsonLine]; }
      catch { return []; }
    });
}

function extractLineText(line: JsonLine): string {
  const msg = line["message"] as JsonLine | undefined;
  if (!msg) return "";

  const role = String(msg["role"] ?? "");
  if (role !== "user" && role !== "assistant") return "";

  const content = msg["content"];
  if (typeof content === "string") {
    return content.trim() ? `${role}: ${content.trim()}` : "";
  }
  if (Array.isArray(content)) {
    const text = (content as JsonLine[])
      .filter((b) => b["type"] === "text")
      .map((b) => String(b["text"] ?? "").trim())
      .filter(Boolean)
      .join(" ");
    return text ? `${role}: ${text}` : "";
  }
  return "";
}

function buildWindow(lines: JsonLine[]): string {
  const segments: string[] = [];
  let total = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const text = extractLineText(lines[i]!);
    if (!text) continue;
    if (total + text.length > WINDOW_CHARS) break;
    segments.unshift(text);
    total += text.length + 1;
  }

  return segments.join("\n");
}

function detectSessionType(input: HookInput, lines: JsonLine[]): SessionDetection {
  if (input.stop_hook_active) {
    return { sessionType: "headless", agentId: cfg.agentId };
  }

  let hasEditTool = false;
  let hasSubagent = false;
  let agentId     = cfg.agentId;

  for (const line of lines) {
    if (String(line["type"] ?? "") === "SubagentStop") {
      hasSubagent = true;
      // Try to extract agent id from the event or its nested message.
      const candidates = [
        line["agent_id"],
        line["subagent_id"],
        line["sub_agent_id"],
        (line["message"] as JsonLine | undefined)?.["agent_id"],
        (line["message"] as JsonLine | undefined)?.["subagent_id"],
        (line["message"] as JsonLine | undefined)?.["sub_agent_id"],
      ];
      const found = candidates.find((v) => typeof v === "string" && v.trim() !== "");
      if (found) agentId = String(found);
      continue;
    }
    const msg = line["message"] as JsonLine | undefined;
    if (!msg) continue;
    const content = msg["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content as JsonLine[]) {
      if (block["type"] === "tool_use" && EDIT_TOOLS.has(String(block["name"] ?? ""))) {
        hasEditTool = true;
      }
    }
  }

  if (hasSubagent) return { sessionType: "multi_agent", agentId };
  if (hasEditTool) return { sessionType: "editing",     agentId };
  return                  { sessionType: "planning",    agentId };
}

// ── Qdrant write ──────────────────────────────────────────────────────────────

async function processOp(
  op:          RouterOp,
  col:         string,
  sessionType: SessionType,
  sessionId:   string,
  agentId:     string,
  cwd:         string,
  threshold:   number,
): Promise<void> {
  if (op.confidence < threshold) return;

  const now    = nowIso();
  const vector = await embedOne(op.text);

  type Hit = Awaited<ReturnType<typeof qd.search>>[number];
  const hits = await qd.search(col, {
    vector,
    filter:          { must: [{ key: "project_id", match: { value: cfg.projectId } }] },
    limit:           1,
    with_payload:    true,
    score_threshold: SIMILARITY_THRESH,
  }).catch((): Hit[] => []);

  const nearest = hits[0];

  if (nearest) {
    // Update status of the existing entry (no re-embed needed).
    await qd.setPayload(col, {
      payload: {
        status:      op.status,
        updated_at:  now,
        resolved_at: op.status === "resolved" ? now : null,
        confidence:  op.confidence,
        source:      "hook-remember:stop",
      },
      points: [nearest.id],
    });
  } else {
    // Insert new entry.
    const id = crypto.randomUUID();
    await qd.upsert(col, {
      points: [{
        id,
        vector,
        payload: {
          text:         op.text,
          status:       op.status,
          session_id:   sessionId,
          session_type: sessionType,
          created_at:   now,
          updated_at:   now,
          resolved_at:  op.status === "resolved" ? now : null,
          confidence:   op.confidence,
          source:       "hook-remember:stop",
          project_id:   cfg.projectId,
          agent_id:     agentId,
          content_hash: contentHash(op.text),
        },
      }],
    });
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end",  ()      => resolve(buf));
  });
}

export async function runHookRemember(): Promise<void> {
  try {
    const raw   = await readStdin();
    const input = JSON.parse(raw.trim() || "{}") as Partial<HookInput>;

    const transcriptPath = input.transcript_path ?? "";
    if (!transcriptPath || !existsSync(transcriptPath)) return;

    const sessionId   = input.session_id ?? "unknown";
    const cwd         = input.cwd ?? process.cwd();
    const rawTranscript = readFileSync(transcriptPath, "utf8");
    const lines       = safeParseLines(rawTranscript);
    if (lines.length === 0) return;

    const { sessionType, agentId } = detectSessionType(input as HookInput, lines);
    const window        = buildWindow(lines);
    if (!window.trim()) return;

    const ops = await runRouter(window);
    if (ops.length === 0) return;

    const col       = colName(sessionType === "multi_agent" ? "memory_agents" : "memory");
    const threshold = CONFIDENCE_THRESH[sessionType];

    // Process ops sequentially to avoid hammering the embedder.
    for (const op of ops) {
      await processOp(op, col, sessionType, sessionId, agentId, cwd, threshold).catch((err: unknown) => {
        process.stderr.write(`[hook-remember] op failed: ${String(err)}\n`);
      });
    }
  } catch (err: unknown) {
    process.stderr.write(`[hook-remember] ${String(err)}\n`);
  }
  // Always exit 0 — non-blocking.
}
