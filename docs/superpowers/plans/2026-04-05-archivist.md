# Archivist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct cosine search in `hook-recall` with Gemma4 as an intelligent archivist that uses tool calling to search Qdrant.

**Architecture:** Extract shared LLM-calling code into `llm-client.ts` with tool-calling support. New `archivist.ts` builds a project profile at server startup (cached in Qdrant), then on each user prompt calls Gemma4 with a `search_memory` tool — Gemma4 decides what to search, receives results, returns relevant context to Claude.

**Tech Stack:** TypeScript/ESM, Qdrant REST client, fetch API (tool calling for Gemini/OpenAI/Anthropic/Ollama)

**Spec:** `docs/superpowers/specs/2026-04-05-archivist-design.md`

---

## File Map

| Action  | File                       | Responsibility                                        |
|---------|----------------------------|-------------------------------------------------------|
| Create  | `src/llm-client.ts`        | Shared LLM client: simple + tool-calling per provider |
| Modify  | `src/router.ts`            | Use `callLlmSimple` from llm-client; remove inline provider fns |
| Create  | `src/archivist.ts`         | Project profile + `runArchivist` + `buildProjectProfile` |
| Modify  | `src/server.ts`            | Call `buildProjectProfile()` at startup               |
| Modify  | `src/hook-recall.ts`       | Delegate entirely to `runArchivist`                   |

---

## Task 1: `src/llm-client.ts` — Shared LLM Client

**Files:**
- Create: `src/llm-client.ts`

- [ ] **Step 1: Create the file**

```typescript
/**
 * Shared LLM client — simple calls and tool-calling for all providers.
 * Extracted from router.ts; used by router.ts (simple) and archivist.ts (tools).
 */

import { cfg, type RouterProviderSpec } from "./config.js";

const MAX_TOKENS = 1024;

// ── Shared types ──────────────────────────────────────────────────────────────

export interface ToolDef {
  name:        string;
  description: string;
  parameters:  Record<string, unknown>; // JSON Schema "object" type
}

// ── Key resolution (moved from router.ts) ────────────────────────────────────

export function resolveApiKey(spec: RouterProviderSpec): string {
  if (spec.api_key) return spec.api_key;
  switch (spec.provider) {
    case "anthropic": return process.env.ANTHROPIC_API_KEY ?? "";
    case "openai":    return process.env.OPENAI_API_KEY    ?? "";
    case "gemini":    return process.env.GEMINI_API_KEY    ?? process.env.GOOGLE_API_KEY ?? "";
    default:          return "";
  }
}

export function resolveBaseUrl(spec: RouterProviderSpec): string {
  if (spec.url) return spec.url;
  switch (spec.provider) {
    case "anthropic": return "https://api.anthropic.com";
    case "openai":    return "https://api.openai.com";
    case "gemini":    return "https://generativelanguage.googleapis.com";
    default:          return cfg.ollamaUrl;
  }
}

// ── Simple call (no tools) ────────────────────────────────────────────────────

/**
 * Single-turn LLM call, no tools. Used by router.ts.
 * Behaviorally identical to the old callProvider() in router.ts.
 */
export async function callLlmSimple(
  prompt: string,
  spec:   RouterProviderSpec,
): Promise<string> {
  const apiKey  = resolveApiKey(spec);
  const baseUrl = resolveBaseUrl(spec);
  switch (spec.provider) {
    case "anthropic": return _callAnthropicSimple(prompt, spec.model, apiKey, baseUrl);
    case "openai":    return _callOpenAISimple(prompt, spec.model, apiKey, baseUrl);
    case "gemini":    return _callGeminiSimple(prompt, spec.model, apiKey, baseUrl);
    default:          return _callOllamaSimple(prompt, spec.model, baseUrl);
  }
}

async function _callOllamaSimple(prompt: string, model: string, baseUrl: string): Promise<string> {
  const resp = await fetch(`${baseUrl}/api/generate`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ model, prompt, stream: false }),
    signal:  AbortSignal.timeout(90_000),
  });
  if (!resp.ok) { const b = await resp.text().catch(() => ""); throw new Error(`Ollama simple: ${resp.status} — ${b}`); }
  const data = await resp.json() as { response: string };
  return data.response;
}

async function _callOpenAISimple(prompt: string, model: string, apiKey: string, baseUrl: string): Promise<string> {
  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body:    JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: MAX_TOKENS }),
    signal:  AbortSignal.timeout(90_000),
  });
  if (!resp.ok) { const b = await resp.text().catch(() => ""); throw new Error(`OpenAI simple: ${resp.status} — ${b}`); }
  const data = await resp.json() as { choices: { message: { content: string } }[] };
  return data.choices[0]!.message.content;
}

async function _callAnthropicSimple(prompt: string, model: string, apiKey: string, baseUrl: string): Promise<string> {
  const resp = await fetch(`${baseUrl}/v1/messages`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body:    JSON.stringify({ model, max_tokens: MAX_TOKENS, messages: [{ role: "user", content: prompt }] }),
    signal:  AbortSignal.timeout(90_000),
  });
  if (!resp.ok) { const b = await resp.text().catch(() => ""); throw new Error(`Anthropic simple: ${resp.status} — ${b}`); }
  const data = await resp.json() as { content: { type: string; text: string }[] };
  return data.content[0]!.text;
}

async function _callGeminiSimple(prompt: string, model: string, apiKey: string, baseUrl: string): Promise<string> {
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: MAX_TOKENS } }),
    signal:  AbortSignal.timeout(90_000),
  });
  if (!resp.ok) { const b = await resp.text().catch(() => ""); throw new Error(`Gemini simple: ${resp.status} — ${b}`); }
  const data = await resp.json() as { candidates: { content: { parts: { text: string }[] } }[] };
  return data.candidates[0]!.content.parts[0]!.text;
}

// ── Tool-enabled call ─────────────────────────────────────────────────────────

/**
 * Single-round tool-calling call. Gemma4 may call one tool; we execute it
 * and send the result back. Returns Gemma4's final text response.
 *
 * toolExecutor receives (toolName, args) and returns a JSON string to feed back.
 */
export async function callLlmWithTools(
  userMessage:  string,
  systemPrompt: string,
  tools:        ToolDef[],
  toolExecutor: (name: string, args: Record<string, unknown>) => Promise<string>,
  spec:         RouterProviderSpec,
): Promise<string> {
  const apiKey  = resolveApiKey(spec);
  const baseUrl = resolveBaseUrl(spec);
  switch (spec.provider) {
    case "anthropic": return _callAnthropicWithTools(userMessage, systemPrompt, tools, toolExecutor, spec.model, apiKey, baseUrl);
    case "openai":    return _callOpenAIWithTools(userMessage, systemPrompt, tools, toolExecutor, spec.model, apiKey, baseUrl);
    case "gemini":    return _callGeminiWithTools(userMessage, systemPrompt, tools, toolExecutor, spec.model, apiKey, baseUrl);
    default:          return _callOllamaWithTools(userMessage, systemPrompt, tools, toolExecutor, spec.model, baseUrl);
  }
}

// ── Ollama tool calling ───────────────────────────────────────────────────────

async function _callOllamaWithTools(
  userMessage:  string,
  systemPrompt: string,
  tools:        ToolDef[],
  toolExecutor: (name: string, args: Record<string, unknown>) => Promise<string>,
  model:        string,
  baseUrl:      string,
): Promise<string> {
  const toolDefs = tools.map(t => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const msgs1 = [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];

  const resp1 = await fetch(`${baseUrl}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: msgs1, tools: toolDefs, stream: false }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp1.ok) { const b = await resp1.text().catch(() => ""); throw new Error(`Ollama tools: ${resp1.status} — ${b}`); }
  const data1 = await resp1.json() as { message: { content: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] } };
  const msg1 = data1.message;

  if (!msg1.tool_calls?.length) return msg1.content;

  const tc = msg1.tool_calls[0]!;
  const toolResult = await toolExecutor(tc.function.name, tc.function.arguments);

  const msgs2 = [...msgs1, { role: "assistant", content: msg1.content, tool_calls: msg1.tool_calls }, { role: "tool", content: toolResult }];
  const resp2 = await fetch(`${baseUrl}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: msgs2, stream: false }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp2.ok) { const b = await resp2.text().catch(() => ""); throw new Error(`Ollama tool result: ${resp2.status} — ${b}`); }
  const data2 = await resp2.json() as { message: { content: string } };
  return data2.message.content;
}

// ── OpenAI tool calling ───────────────────────────────────────────────────────

async function _callOpenAIWithTools(
  userMessage:  string,
  systemPrompt: string,
  tools:        ToolDef[],
  toolExecutor: (name: string, args: Record<string, unknown>) => Promise<string>,
  model:        string,
  apiKey:       string,
  baseUrl:      string,
): Promise<string> {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  const toolDefs = tools.map(t => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const msgs1 = [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];

  const resp1 = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST", headers,
    body: JSON.stringify({ model, messages: msgs1, tools: toolDefs, max_tokens: MAX_TOKENS }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp1.ok) { const b = await resp1.text().catch(() => ""); throw new Error(`OpenAI tools: ${resp1.status} — ${b}`); }
  const data1 = await resp1.json() as { choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
  const msg1 = data1.choices[0]!.message;

  if (!msg1.tool_calls?.length) return msg1.content ?? "";

  const tc = msg1.tool_calls[0]!;
  const toolArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
  const toolResult = await toolExecutor(tc.function.name, toolArgs);

  const msgs2 = [...msgs1, msg1, { role: "tool", tool_call_id: tc.id, content: toolResult }];
  const resp2 = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST", headers,
    body: JSON.stringify({ model, messages: msgs2, max_tokens: MAX_TOKENS }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp2.ok) { const b = await resp2.text().catch(() => ""); throw new Error(`OpenAI tool result: ${resp2.status} — ${b}`); }
  const data2 = await resp2.json() as { choices: { message: { content: string } }[] };
  return data2.choices[0]!.message.content;
}

// ── Anthropic tool calling ────────────────────────────────────────────────────

async function _callAnthropicWithTools(
  userMessage:  string,
  systemPrompt: string,
  tools:        ToolDef[],
  toolExecutor: (name: string, args: Record<string, unknown>) => Promise<string>,
  model:        string,
  apiKey:       string,
  baseUrl:      string,
): Promise<string> {
  const headers = { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  const toolDefs = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));

  const resp1 = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST", headers,
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system: systemPrompt, tools: toolDefs, messages: [{ role: "user", content: userMessage }] }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp1.ok) { const b = await resp1.text().catch(() => ""); throw new Error(`Anthropic tools: ${resp1.status} — ${b}`); }
  const data1 = await resp1.json() as { content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]; stop_reason: string };

  const toolUse = data1.content.find(c => c.type === "tool_use");
  if (!toolUse?.id || !toolUse.name) {
    return data1.content.find(c => c.type === "text")?.text ?? "";
  }

  const toolResult = await toolExecutor(toolUse.name, toolUse.input ?? {});

  const resp2 = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST", headers,
    body: JSON.stringify({
      model, max_tokens: MAX_TOKENS, system: systemPrompt, tools: toolDefs,
      messages: [
        { role: "user",      content: userMessage },
        { role: "assistant", content: data1.content },
        { role: "user",      content: [{ type: "tool_result", tool_use_id: toolUse.id, content: toolResult }] },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp2.ok) { const b = await resp2.text().catch(() => ""); throw new Error(`Anthropic tool result: ${resp2.status} — ${b}`); }
  const data2 = await resp2.json() as { content: { type: string; text?: string }[] };
  return data2.content.find(c => c.type === "text")?.text ?? "";
}

// ── Gemini tool calling ───────────────────────────────────────────────────────

async function _callGeminiWithTools(
  userMessage:  string,
  systemPrompt: string,
  tools:        ToolDef[],
  toolExecutor: (name: string, args: Record<string, unknown>) => Promise<string>,
  model:        string,
  apiKey:       string,
  baseUrl:      string,
): Promise<string> {
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const toolDefs = { tools: [{ function_declarations: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }] };
  const genCfg = { generationConfig: { maxOutputTokens: MAX_TOKENS } };

  // Gemini: system prompt is prepended to the first user turn
  const contents1 = [{ role: "user", parts: [{ text: `${systemPrompt}\n\n${userMessage}` }] }];

  const resp1 = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: contents1, ...toolDefs, ...genCfg }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp1.ok) { const b = await resp1.text().catch(() => ""); throw new Error(`Gemini tools: ${resp1.status} — ${b}`); }
  const data1 = await resp1.json() as {
    candidates: { content: { role: string; parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }> } }[];
  };

  const parts1 = data1.candidates[0]!.content.parts;
  const fcPart = parts1.find(p => p.functionCall);
  if (!fcPart?.functionCall) return parts1.find(p => p.text)?.text ?? "";

  const fc = fcPart.functionCall;
  const toolResult = await toolExecutor(fc.name, fc.args);

  const contents2 = [
    ...contents1,
    { role: "model", parts: [{ functionCall: { name: fc.name, args: fc.args } }] },
    { role: "user",  parts: [{ functionResponse: { name: fc.name, response: { content: toolResult } } }] },
  ];

  const resp2 = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: contents2, ...toolDefs, ...genCfg }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp2.ok) { const b = await resp2.text().catch(() => ""); throw new Error(`Gemini tool result: ${resp2.status} — ${b}`); }
  const data2 = await resp2.json() as { candidates: { content: { parts: { text?: string }[] } }[] };
  return data2.candidates[0]!.content.parts.find(p => p.text)?.text ?? "";
}
```

- [ ] **Step 2: Verify TypeScript compilation**

```bash
pnpm tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/llm-client.ts
git commit --no-gpg-sign -m "feat: add llm-client.ts with simple + tool-calling support"
```

---

## Task 2: Migrate `src/router.ts` to use `callLlmSimple`

**Files:**
- Modify: `src/router.ts`

- [ ] **Step 1: Replace imports and remove inline provider functions**

Replace the entire `src/router.ts` with:

```typescript
/**
 * LLM router — memory extraction from conversation transcripts.
 * Provider calling is delegated to llm-client.ts.
 */

import { cfg, type RouterProviderSpec } from "./config.js";
import { callLlmSimple } from "./llm-client.js";
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

/** Build a RouterProviderSpec from the existing llm-* config keys. */
function defaultSpec(): RouterProviderSpec {
  return {
    provider: cfg.llmProvider as RouterProviderSpec["provider"],
    model:    cfg.llmModel,
    api_key:  cfg.llmApiKey || undefined,
    url:      cfg.llmUrl    || undefined,
  };
}

/**
 * Run the LLM router on a transcript window.
 * Returns extracted memory operations. Returns [] on any error.
 */
export async function runRouter(window: string): Promise<RouterOp[]> {
  const primarySpec  = cfg.routerConfig ?? defaultSpec();
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
```

- [ ] **Step 2: Verify compilation and that debugLog calls still work**

```bash
pnpm tsc --noEmit 2>&1
```

Expected: no errors. (Note: `debugLog` calls were in router.ts from the previous debug logging work — they were removed in the rewrite above. Re-add them now:)

In `runRouter`, after `raw = await callLlmSimple(prompt, primarySpec)`:
```typescript
debugLog("router", `primary response len=${raw.length}`);
```

Add `import { debugLog } from "./util.js";` at the top. Add similar `debugLog` calls matching the ones added in the previous session (see git log for the exact lines).

- [ ] **Step 3: Commit**

```bash
git add src/router.ts
git commit --no-gpg-sign -m "refactor: router.ts uses callLlmSimple from llm-client"
```

---

## Task 3: `src/archivist.ts` — Project Profile + Archivist Agent

**Files:**
- Create: `src/archivist.ts`

- [ ] **Step 1: Create the file**

```typescript
/**
 * Archivist — LLM-powered memory retrieval.
 *
 * buildProjectProfile(): call once at server startup to cache a project profile
 *   in Qdrant (key topics, tags, collection stats). TTL: 24h.
 *
 * runArchivist(prompt): called by hook-recall on each user prompt.
 *   Loads the cached profile, calls Gemma4 with a search_memory tool,
 *   executes the search, returns Gemma4's final text to inject as systemMessage.
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

// ── Project profile ───────────────────────────────────────────────────────────

function _defaultSpec(): RouterProviderSpec {
  return {
    provider: cfg.llmProvider as RouterProviderSpec["provider"],
    model:    cfg.llmModel,
    api_key:  cfg.llmApiKey || undefined,
    url:      cfg.llmUrl    || undefined,
  };
}

async function _loadProfile(): Promise<ProjectProfile | null> {
  const { points } = await qd.scroll(colName("memory"), {
    filter: {
      must: [
        { key: "project_id", match: { value: cfg.projectId } },
        { key: "_type",      match: { value: PROFILE_TYPE } },
      ],
    },
    limit: 1,
    with_payload: true,
  }).catch(() => ({ points: [] as typeof points }));

  if (!points.length) return null;

  const p       = (points[0]!.payload ?? {}) as Record<string, unknown>;
  const builtAt = String(p["builtAt"] ?? "");
  if (!builtAt) return null;

  const ageMs = Date.now() - new Date(builtAt).getTime();
  if (ageMs > PROFILE_TTL_H * 3_600_000) return null;

  return {
    projectId:       String(p["projectId"] ?? ""),
    builtAt,
    topTags:         Array.isArray(p["topTags"])         ? (p["topTags"]         as string[]) : [],
    topTopics:       Array.isArray(p["topTopics"])       ? (p["topTopics"]       as string[]) : [],
    collectionStats: typeof p["collectionStats"] === "object" && p["collectionStats"] !== null
      ? (p["collectionStats"] as Record<string, number>)
      : {},
  };
}

/**
 * Build and cache a project profile in Qdrant.
 * Call once at server startup; no-op if a fresh profile already exists.
 */
export async function buildProjectProfile(): Promise<void> {
  const cached = await _loadProfile();
  if (cached) {
    process.stderr.write(`[archivist] profile cached (built ${cached.builtAt})\n`);
    debugLog("archivist", `profile cached builtAt=${cached.builtAt}`);
    return;
  }

  const collectionBases = ["memory", "memory_episodic", "memory_semantic"];
  const samples: string[]             = [];
  const tagCounts: Record<string, number> = {};
  const stats: Record<string, number>     = {};

  type ScrollPt = { payload?: Record<string, unknown> };
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

  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([t]) => t);

  if (samples.length === 0) {
    process.stderr.write(`[archivist] no samples found — skipping profile build\n`);
    return;
  }

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

  const vector = await embedOne(topTopics.join(" "));
  await qd.upsert(colName("memory"), {
    points: [{
      id:      crypto.randomUUID(),
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
  const query       = String(args["query"] ?? "").trim();
  const colBases    = Array.isArray(args["collections"]) && (args["collections"] as string[]).length > 0
    ? (args["collections"] as string[])
    : ["memory", "episodic", "semantic", "procedural"];
  const status      = String(args["status"] ?? "");
  const limit       = Math.min(Number(args["limit"] ?? 10), 20);

  debugLog("archivist", `tool_call search_memory query="${query.slice(0, 80)}" cols=[${colBases.join(",")}] status=${status}`);

  if (!query) return JSON.stringify({ results: [] });

  const vector = await embedOne(query);

  const mustFilter: Array<{ key: string; match: { value: string } }> = [
    { key: "project_id", match: { value: cfg.projectId } },
  ];
  if (status) mustFilter.push({ key: "status", match: { value: status } });

  const collections = colBases.map(b => colName(b === "memory" ? "memory" : `memory_${b}`));

  type QHit = Awaited<ReturnType<typeof qd.search>>[number];
  const allHits: QHit[] = [];

  await Promise.all(collections.map(async col => {
    const hits = await qd.search(col, {
      vector,
      filter:          { must: mustFilter },
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
```

- [ ] **Step 2: Verify TypeScript compilation**

```bash
pnpm tsc --noEmit 2>&1
```

Expected: no errors. Fix any type errors before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/archivist.ts
git commit --no-gpg-sign -m "feat: add archivist.ts with project profile and LLM-powered retrieval"
```

---

## Task 4: Wire `buildProjectProfile` into server startup

**Files:**
- Modify: `src/server.ts` lines ~477-484

- [ ] **Step 1: Add import at top of server.ts**

After the existing imports block, add:

```typescript
import { buildProjectProfile } from "./archivist.js";
```

- [ ] **Step 2: Call buildProjectProfile after ensureCollections**

Find line `await ensureCollections();` (~line 477) and add immediately after:

```typescript
// Build project profile for the archivist (non-blocking — failure is logged, not fatal).
buildProjectProfile().catch((err: unknown) => {
  process.stderr.write(`[archivist] profile build failed: ${String(err)}\n`);
});
```

- [ ] **Step 3: Verify compilation**

```bash
pnpm tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit --no-gpg-sign -m "feat: call buildProjectProfile at server startup"
```

---

## Task 5: Simplify `src/hook-recall.ts` to delegate to archivist

**Files:**
- Modify: `src/hook-recall.ts`

- [ ] **Step 1: Replace hook-recall.ts with archivist delegation**

Replace the entire file with:

```typescript
import { debugLog } from "./util.js";
import { runArchivist } from "./archivist.js";

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end",  ()      => resolve(buf));
  });
}

export async function runHookRecall(): Promise<void> {
  try {
    const raw   = await readStdin();
    const input = JSON.parse(raw.trim() || "{}") as { prompt?: string };
    const prompt = (input.prompt ?? "").trim();

    if (!prompt) {
      process.stdout.write('{"systemMessage":""}\n');
      return;
    }

    debugLog("hook-recall", `prompt="${prompt.slice(0, 100)}"`);

    const systemMessage = await runArchivist(prompt);
    process.stdout.write(JSON.stringify({ systemMessage }) + "\n");
  } catch {
    process.stdout.write('{"systemMessage":""}\n');
  }
}
```

- [ ] **Step 2: Verify compilation**

```bash
pnpm tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Build**

```bash
pnpm build 2>&1 | tail -3
```

Expected: `Output location: .../dist/dashboard-ui`

- [ ] **Step 4: Commit**

```bash
git add src/hook-recall.ts
git commit --no-gpg-sign -m "feat: hook-recall delegates to archivist"
```

---

## Task 6: End-to-end Verification

- [ ] **Step 1: Reconnect MCP and watch logs**

```bash
tail -f /tmp/local-rag-debug.log
```

- [ ] **Step 2: Verify profile build on server start**

After `/mcp` reconnect in Claude Code, check stderr for:
```
[archivist] profile cached (built ...)
```
or
```
[archivist] profile built: topics=[...] tags=N
```

- [ ] **Step 3: Send a test prompt and observe archivist in logs**

Expected log sequence:
```
[hook-recall]   prompt="..."
[archivist]     prompt="..."
[archivist]     profile=loaded
[archivist]     tool_call search_memory query="..." cols=[...] status=
[archivist]     search results=N
[archivist]     response len=N
```

- [ ] **Step 4: Verify cross-language improvement**

Send a Russian prompt about hooks/logging. Check that archivist's `search_memory` query is in English (visible in debug log).

- [ ] **Step 5: Force profile rebuild (optional)**

To force a fresh profile, scroll `gemma_memory` and delete the entry with `_type=project-profile`. On next MCP reconnect it will rebuild.
