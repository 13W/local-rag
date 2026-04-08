/**
 * LLM router — memory extraction from conversation transcripts.
 * Provider calling is delegated to llm-client.ts.
 */

import { cfg } from "./config.js";
import { callLlmTool, defaultRouterSpec, type ToolDef } from "./llm-client.js";
import { debugLog } from "./util.js";
import type { Status } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RouterOp {
  text:       string;
  status:     Status;
  confidence: number;
}

// ── Router prompt ─────────────────────────────────────────────────────────────

const ROUTER_PROMPT = `You are a memory extraction system for an AI coding agent. Your goal is to capture high-value insights, research findings, technical discoveries, and observations about the environment.
Analyze the conversation and tool usage logs to extract items worth persisting across sessions.

GUIDELINES:
1. TECHNICAL OBSERVATIONS: Capture subtle nuances (e.g., 'JSON editing on FreeBSD adds trailing \\n', 'The MCP tool hangs if the response exceeds 1MB').
2. PATTERNS & ROOT CAUSES: If multiple similar problems occurred, synthesize the pattern. If a problem was investigated, extract the root cause and the fix.
3. RESOLVED ISSUES: When a problem mentioned earlier is fixed, mark it as 'resolved'.
4. ARCHITECTURAL DECISIONS: Record any agreed-upon patterns or directions.
5. STAND-ALONE TEXT: Ensure the 'text' field is clear and descriptive without needing the full context.

Only include items with confidence > 0.6.
You must call the provided tool to record your findings.

Transcript excerpt (includes tool calls and summarized results):
`;

const RECORD_MEMORY_TOOL: ToolDef = {
  name: "record_memory",
  description: "Record high-value insights, research findings, technical discoveries, and observations.",
  parameters: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: `Self-contained memory entry. Use structured format based on status:
- resolved (bug/incident/fix): "Problem: <what went wrong>\nRoot cause: <why it happened>\nFix: <what resolved it>\nFiles: src/path/to/file.ts"
- observation: "Observed: <what was noticed>\nContext: <when/where>\nImpact: <why it matters>"
- open_question: "Question: <what is unclear>\nContext: <background>\nAttempted: <what was tried, if anything>"
- in_progress: plain descriptive text explaining what is being worked on and why
- hypothesis: plain descriptive text with the proposed idea and its rationale
Always include enough context to be understood without the original conversation.`,
            },
            status: { type: "string", enum: ["in_progress", "resolved", "open_question", "hypothesis", "observation"] },
            confidence: { type: "number", description: "Confidence score 0.0-1.0 (must be > 0.6)" }
          },
          required: ["text", "status", "confidence"]
        }
      }
    },
    required: ["operations"]
  }
};

// ── Response parsing ──────────────────────────────────────────────────────────

const VALID_STATUSES = new Set<string>(["in_progress", "resolved", "open_question", "hypothesis", "observation"]);

function extractValidOps(parsed: unknown[]): RouterOp[] {
  return parsed.flatMap((item) => {
    if (typeof item !== "object" || !item) return [];
    const o = item as Record<string, unknown>;
    const text = String(o["text"] ?? "").trim();
    if (!text) return [];
    const status = String(o["status"] ?? "");
    if (!VALID_STATUSES.has(status)) return [];
    const confidence = Number(o["confidence"] ?? 0);
    if (isNaN(confidence) || confidence < 0.4) return [];
    return [{ text, status: status as Status, confidence }];
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

  const args = await (async () => {
    try {
      const r = await callLlmTool(prompt, RECORD_MEMORY_TOOL, primarySpec);
      debugLog("router", `primary tool call successful: ${r !== null}`);
      return r;
    } catch (primaryErr: unknown) {
      process.stderr.write(`[router] primary failed: ${String(primaryErr)}\n`);
      debugLog("router", `primary failed: ${String(primaryErr)}`);
      if (!fallbackSpec) return null;
      debugLog("router", `trying fallback provider=${fallbackSpec.provider} model=${fallbackSpec.model}`);
      try {
        const r = await callLlmTool(prompt, RECORD_MEMORY_TOOL, fallbackSpec);
        debugLog("router", `fallback tool call successful: ${r !== null}`);
        return r;
      } catch (fallbackErr: unknown) {
        process.stderr.write(`[router] fallback failed: ${String(fallbackErr)}\n`);
        debugLog("router", `fallback failed: ${String(fallbackErr)}`);
        return null;
      }
    }
  })();

  if (!args || !Array.isArray(args.operations)) {
    debugLog("router", "no valid operations found or tool was not called");
    return [];
  }

  const ops = extractValidOps(args.operations);
  debugLog("router", `extracted ops=${ops.length}`);
  
  return ops;
}
