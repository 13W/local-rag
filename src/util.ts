import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import type { StoreMemoryParams } from "./types.js";
import type { RouterOp } from "./router.js";
import { cfg } from "./config.js";
import { qd, colName } from "./qdrant.js";
import { embedOne } from "./embedder.js";
import { broadcastMemoryUpdate } from "./plugins/dashboard.js";
import { getProjectId, getAgentId } from  './request-context.js'

export function colForType(memoryType: string): string {
  return colName(`memory_${memoryType}`);
}

export function contentHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function storeMemory(params: StoreMemoryParams): Promise<string> {
  const { content, memoryType, scope, tags, importance, ttlHours } = params;

  if (!["episodic", "semantic", "procedural"].includes(memoryType)) {
    return "error: memory_type must be: episodic, semantic, procedural";
  }

  const colName = colForType(memoryType);
  const hash = contentHash(content);

  const { points: existing } = await qd.scroll(colName, {
    filter: {
      must: [
        { key: "content_hash", match: { value: hash } },
        { key: "project_id",   match: { value: getProjectId() } },
      ],
    },
    limit: 1,
  });
  if (existing.length > 0) {
    return `already exists: ${existing[0]!.id}`;
  }

  const memId  = crypto.randomUUID();
  const now    = nowIso();
  const tagList = tags
    ? tags.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  const expiresAt = ttlHours > 0
    ? new Date(Date.now() + ttlHours * 3_600_000).toISOString()
    : "";

  const embedding = await embedOne(content);

  await qd.upsert(colName, {
    points: [
      {
        id:      memId,
        vector:  embedding,
        payload: {
          content,
          agent_id:     getAgentId(),
          project_id:   getProjectId(),
          memory_type:  memoryType,
          scope,
          importance,
          access_count: 0,
          tags:         tagList,
          content_hash: hash,
          created_at:   now,
          updated_at:   now,
          expires_at:   expiresAt,
        },
      },
    ],
  });

  void broadcastMemoryUpdate();

  return `stored [${memoryType}]: ${memId} (importance=${importance})`;
}

/**
 * Format borderline-confidence ops as a systemMessage asking Claude to call
 * the request_validation MCP tool for each entry.
 * Returns null when the list is empty.
 */
export function buildValidationRequests(ops: RouterOp[]): string | null {
  if (ops.length === 0) return null;

  const lines = [
    "Memory router needs validation for the following entries.",
    "Call request_validation for each:",
    "",
  ];

  ops.forEach((op, i) => {
    lines.push(
      `${i + 1}. text: "${op.text.replace(/\n/g, " ").slice(0, 200)}" | status: ${op.status} | confidence: ${op.confidence.toFixed(2)}`,
    );
  });

  return lines.join("\n");
}

// ── Transcript helpers ────────────────────────────────────────────────────────

export type JsonLine = Record<string, unknown>;

export function safeParseLines(raw: string): JsonLine[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (Array.isArray(parsed["messages"])) {
        return parsed["messages"] as JsonLine[];
      }
    } catch {
      // Fall through to line-by-line parsing
    }
  }

  return trimmed
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line) as JsonLine]; }
      catch { return []; }
    });
}

export function extractLineText(line: JsonLine): string {
  // Case 1: claude-code wrapped in "message" key
  let msg = line["message"] as JsonLine | undefined;
  let role: string;

  if (msg) {
    role = String(msg["role"] ?? "");
  } else {
    // Case 2: gemini-cli or raw message object
    msg  = line;
    role = String(msg["role"] ?? msg["type"] ?? "");
  }

  // Handle special gemini-cli types that aren't 'user'/'assistant' but carry info
  if (role === "tool_use" || role === "tool_call") {
    const name = String(msg["name"] ?? (msg["functionCall"] as JsonLine)?.["name"] ?? "tool");
    return `[Tool Use: ${name}]`;
  }
  if (role === "tool_result" || role === "tool_response") {
    const content = msg["content"] ?? (msg["functionResponse"] as JsonLine)?.["response"];
    const text = typeof content === "string" ? content : JSON.stringify(content);
    return `[Tool Result: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}]`;
  }

  if (role !== "user" && role !== "assistant") return "";

  const content = msg["content"];
  if (typeof content === "string") {
    return content.trim() ? `${role}: ${content.trim()}` : "";
  }
  if (Array.isArray(content)) {
    const segments = (content as JsonLine[])
      .map((b) => {
        if (typeof b === "string") return b;
        // gemini-cli: { "text": "..." }
        if (typeof b["text"] === "string") return b["text"];
        // tool calls inside content blocks
        if (b["type"] === "tool_use") return `[Tool Use: ${b["name"]}]`;
        if (b["type"] === "tool_result") return `[Tool Result: ${String(b["content"]).slice(0, 100)}...]`;
        // claude-code: { "type": "text", "text": "..." }
        if (b["type"] === "text" && typeof b["text"] === "string") return b["text"];
        return "";
      })
      .map((s) => s.trim())
      .filter(Boolean);
    
    const text = segments.join(" ");
    return text ? `${role}: ${text}` : "";
  }
  return "";
}

/**
 * Build a transcript window of up to `maxChars` from parsed lines.
 */
export function buildWindow(lines: JsonLine[], maxChars: number): string {
  const segments: string[] = [];
  let total = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const text = extractLineText(lines[i]!);
    if (!text) continue;
    if (total + text.length > maxChars) break;
    segments.unshift(text);
    total += text.length + 1;
  }

  return segments.join("\n");
}

/**
 * Read up to `maxChars` of recent conversation from `transcriptPath`.
 * Returns empty string if the file is missing or unreadable.
 */
export function buildTranscriptContext(transcriptPath: string, maxChars: number): string {
  if (!transcriptPath || !existsSync(transcriptPath)) return "";
  try {
    const raw   = readFileSync(transcriptPath, "utf8");
    const lines = safeParseLines(raw);
    return buildWindow(lines, maxChars);
  } catch {
    return "";
  }
}

// ── Logging ───────────────────────────────────────────────────────────────────

/**
 * Append one verbose log line to cfg.debugLogPath when debug logging is enabled.
 * Errors are suppressed — logging must never block execution.
 */
export function debugLog(module: string, msg: string): void {
  if (!cfg.debugLogPath) return;
  try {
    const ts   = new Date().toISOString();
    const pid  = getProjectId();
    const aid  = getAgentId();
    const line = `${ts}  [${pid}/${aid}] [${module}]  ${msg}\n`;
    appendFileSync(cfg.debugLogPath, line, "utf8");
  } catch {
    // intentionally silent
  }
}

/**
 * Append one line to {cwd}/.memory-headless.log describing a headless-session
 * write/skip decision. Errors are suppressed — logging must never block the hook.
 */
export function logHeadlessDecision(
  cwd:     string,
  op:      RouterOp,
  written: boolean,
): void {
  try {
    const ts      = new Date().toISOString();
    const outcome = written ? "written" : "skipped";
    const conf    = op.confidence.toFixed(2);
    const text    = op.text.replace(/\n/g, " ").slice(0, 120);
    const line    = `${ts}  ${outcome.padEnd(7)}  conf=${conf}  ${op.status.padEnd(14)}  "${text}"\n`;
    appendFileSync(`${cwd}/.memory-headless.log`, line, "utf8");
  } catch {
    // intentionally silent
  }
}
