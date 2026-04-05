/**
 * LLM router — memory extraction from conversation transcripts.
 *
 * Reads provider config from .memory.json "router" key.
 * Falls back to the "llm-provider" / "llm-model" settings when no router
 * block is present. Supports a nested "fallback" provider tried on failure.
 */

import { cfg, type RouterProviderSpec } from "./config.js";
import { debugLog } from "./util.js";
import type { Status } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RouterOp {
  text:       string;
  status:     Status;
  confidence: number;
}

// ── Router prompt (spec-defined) ──────────────────────────────────────────────

const ROUTER_PROMPT =
  "You are a memory extraction system for an AI coding agent.\n" +
  "Analyze this conversation excerpt and extract facts, decisions,\n" +
  "and open questions worth persisting across sessions.\n\n" +
  'For each item output JSON: { "text": "...", "status": "...", "confidence": 0.0-1.0 }\n' +
  "Status must be one of: in_progress, resolved, open_question, hypothesis\n" +
  "Only include items with confidence > 0.6.\n" +
  "Output a JSON array only. No explanation. No markdown.\n\n" +
  "Conversation excerpt:\n";

const MAX_TOKENS = 1024;

// ── Provider implementations ──────────────────────────────────────────────────

async function callOllama(
  prompt:   string,
  model:    string,
  baseUrl:  string,
): Promise<string> {
  const resp = await fetch(`${baseUrl}/api/generate`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ model, prompt, stream: false }),
    signal:  AbortSignal.timeout(90_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Ollama router failed: ${resp.status} — ${body}`);
  }
  const data = (await resp.json()) as { response: string };
  return data.response;
}

async function callOpenAI(
  prompt:   string,
  model:    string,
  apiKey:   string,
  baseUrl:  string,
): Promise<string> {
  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body:    JSON.stringify({
      model,
      messages:   [{ role: "user", content: prompt }],
      max_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`OpenAI router failed: ${resp.status} — ${body}`);
  }
  const data = (await resp.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]!.message.content;
}

async function callAnthropic(
  prompt:   string,
  model:    string,
  apiKey:   string,
  baseUrl:  string,
): Promise<string> {
  const resp = await fetch(`${baseUrl}/v1/messages`, {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      messages:   [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Anthropic router failed: ${resp.status} — ${body}`);
  }
  const data = (await resp.json()) as { content: { type: string; text: string }[] };
  return data.content[0]!.text;
}

async function callGemini(
  prompt:  string,
  model:   string,
  apiKey:  string,
  baseUrl: string,
): Promise<string> {
  const url =
    `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      contents:         [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: MAX_TOKENS },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Gemini router failed: ${resp.status} — ${body}`);
  }
  const data = (await resp.json()) as {
    candidates: { content: { parts: { text: string }[] } }[];
  };
  return data.candidates[0]!.content.parts[0]!.text;
}

// ── Provider dispatch ─────────────────────────────────────────────────────────

function resolveApiKey(spec: RouterProviderSpec): string {
  if (spec.api_key) return spec.api_key;
  switch (spec.provider) {
    case "anthropic": return process.env.ANTHROPIC_API_KEY ?? "";
    case "openai":    return process.env.OPENAI_API_KEY    ?? "";
    case "gemini":    return process.env.GEMINI_API_KEY    ?? process.env.GOOGLE_API_KEY ?? "";
    default:          return "";
  }
}

function resolveBaseUrl(spec: RouterProviderSpec): string {
  if (spec.url) return spec.url;
  switch (spec.provider) {
    case "anthropic": return "https://api.anthropic.com";
    case "openai":    return "https://api.openai.com";
    case "gemini":    return "https://generativelanguage.googleapis.com";
    default:          return cfg.ollamaUrl;
  }
}

async function callProvider(spec: RouterProviderSpec, prompt: string): Promise<string> {
  const apiKey  = resolveApiKey(spec);
  const baseUrl = resolveBaseUrl(spec);

  switch (spec.provider) {
    case "anthropic": return callAnthropic(prompt, spec.model, apiKey, baseUrl);
    case "openai":    return callOpenAI(prompt, spec.model, apiKey, baseUrl);
    case "gemini":    return callGemini(prompt, spec.model, apiKey, baseUrl);
    default:          return callOllama(prompt, spec.model, baseUrl);
  }
}

/** Build a RouterProviderSpec from the existing llm-* config keys (fallback when no "router" block). */
function defaultSpec(): RouterProviderSpec {
  return {
    provider: cfg.llmProvider as RouterProviderSpec["provider"],
    model:    cfg.llmModel,
    api_key:  cfg.llmApiKey || undefined,
    url:      cfg.llmUrl    || undefined,
  };
}

// ── Response parsing ──────────────────────────────────────────────────────────

const VALID_STATUSES = new Set<string>(["in_progress", "resolved", "open_question", "hypothesis"]);

function parseOps(raw: string): RouterOp[] {
  // Some models output chain-of-thought before the final JSON.
  // Find all candidate [...] blocks and try from the last one backwards.
  const candidates: string[] = [];
  const re = /\[[\s\S]*?\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) candidates.push(m[0]);

  // Also try the greedy span from the last '[' to the end, which captures
  // multi-line arrays the non-greedy regex may split across multiple matches.
  const lastBracket = raw.lastIndexOf("[");
  if (lastBracket !== -1) candidates.push(raw.slice(lastBracket));

  let parsed: unknown;
  let found = false;
  for (let i = candidates.length - 1; i >= 0; i--) {
    try { parsed = JSON.parse(candidates[i]!); found = true; break; }
    catch { /* try next */ }
  }
  if (!found) return [];

  if (!Array.isArray(parsed)) return [];

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
 * Returns extracted memory operations. Returns [] on any error — never throws.
 */
export async function runRouter(window: string): Promise<RouterOp[]> {
  const primarySpec  = cfg.routerConfig ?? defaultSpec();
  const fallbackSpec = cfg.routerConfig?.fallback ?? null;
  const prompt       = ROUTER_PROMPT + window;

  debugLog("router", `calling provider=${primarySpec.provider} model=${primarySpec.model} prompt_len=${prompt.length}`);

  let raw: string;
  try {
    raw = await callProvider(primarySpec, prompt);
    debugLog("router", `primary response len=${raw.length}`);
  } catch (primaryErr: unknown) {
    process.stderr.write(`[router] primary failed: ${String(primaryErr)}\n`);
    debugLog("router", `primary failed: ${String(primaryErr)}`);
    if (!fallbackSpec) return [];
    debugLog("router", `trying fallback provider=${fallbackSpec.provider} model=${fallbackSpec.model}`);
    try {
      raw = await callProvider(fallbackSpec, prompt);
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
