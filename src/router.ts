/**
 * LLM router — memory extraction from conversation transcripts.
 * Provider calling is delegated to llm-client.ts.
 */

import { cfg } from "./config.js";
import { callLlmSimple, defaultRouterSpec } from "./llm-client.js";
import { debugLog } from "./util.js";
import type { Status } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RouterOp {
  text:       string;
  status:     Status;
  confidence: number;
}

// ── Router prompt ─────────────────────────────────────────────────────────────

const ROUTER_PROMPT =
  "You are a memory extraction system for an AI coding agent.\n" +
  "Analyze this conversation excerpt and extract facts, decisions,\n" +
  "and open questions worth persisting across sessions.\n\n" +
  'For each item output JSON: { "text": "...", "status": "...", "confidence": 0.0-1.0 }\n' +
  "Status must be one of: in_progress, resolved, open_question, hypothesis\n" +
  "Only include items with confidence > 0.6.\n" +
  "Output a JSON array only. No explanation. No markdown.\n\n" +
  "Conversation excerpt:\n";

// ── Response parsing ──────────────────────────────────────────────────────────

const VALID_STATUSES = new Set<string>(["in_progress", "resolved", "open_question", "hypothesis"]);

function parseOps(raw: string): RouterOp[] {
  const candidates: string[] = [];
  const re = /\[[\s\S]*?\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) candidates.push(m[0]);
  const lastBracket = raw.lastIndexOf("[");
  if (lastBracket !== -1) candidates.push(raw.slice(lastBracket));

  let parsed: unknown;
  let found = false;
  for (let i = candidates.length - 1; i >= 0; i--) {
    try { parsed = JSON.parse(candidates[i]!); found = true; break; }
    catch { /* try next */ }
  }
  if (!found || !Array.isArray(parsed)) return [];

  return (parsed as unknown[]).flatMap((item) => {
    if (typeof item !== "object" || !item) return [];
    const o = item as Record<string, unknown>;
    if (typeof o["text"] !== "string" || !o["text"].trim()) return [];
    const status = String(o["status"] ?? "");
    if (!VALID_STATUSES.has(status)) return [];
    const confidence = Number(o["confidence"] ?? 0);
    if (confidence < 0.6) return [];
    return [{ text: o["text"].trim(), status: status as Status, confidence }];
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the LLM router on a transcript window.
 * Returns extracted memory operations. Returns [] on any error.
 */
export async function runRouter(window: string): Promise<RouterOp[]> {
  const primarySpec  = cfg.routerConfig ?? defaultRouterSpec();
  const fallbackSpec = cfg.routerConfig?.fallback ?? null;
  const prompt       = ROUTER_PROMPT + window;

  debugLog("router", `calling provider=${primarySpec.provider} model=${primarySpec.model} prompt_len=${prompt.length}`);

  let raw: string;
  try {
    raw = await callLlmSimple(prompt, primarySpec);
    debugLog("router", `primary response len=${raw.length}`);
  } catch (primaryErr: unknown) {
    process.stderr.write(`[router] primary failed: ${String(primaryErr)}\n`);
    debugLog("router", `primary failed: ${String(primaryErr)}`);
    if (!fallbackSpec) return [];
    debugLog("router", `trying fallback provider=${fallbackSpec.provider} model=${fallbackSpec.model}`);
    try {
      raw = await callLlmSimple(prompt, fallbackSpec);
      debugLog("router", `fallback response len=${raw.length}`);
    } catch (fallbackErr: unknown) {
      process.stderr.write(`[router] fallback failed: ${String(fallbackErr)}\n`);
      debugLog("router", `fallback failed: ${String(fallbackErr)}`);
      return [];
    }
  }

  const ops = parseOps(raw);
  debugLog("router", `parsed ops=${ops.length}`);
  return ops;
}
