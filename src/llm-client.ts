/**
 * Shared LLM client — simple calls and tool-calling for all providers.
 * Extracted from router.ts; used by router.ts (simple) and archivist.ts (tools).
 */

import { cfg, type RouterProviderSpec } from "./config.js";

const MAX_TOKENS = 1024;

// Rate limiting & Retry state
let _pausedUntil = 0;
const CONCURRENCY_LIMIT = 5;
let _activeCalls = 0;
const _queue: Array<() => void> = [];

/** Internal fetch wrapper to add context to errors (especially timeouts). */
async function _fetchWithLogging(url: string, options: RequestInit, model: string): Promise<Response> {
  try {
    return await fetch(url, options);
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.message.includes("timeout") || err.message.includes("aborted"))) {
      const urlObj = new URL(url);
      const cleanUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
      throw new Error(`TimeoutError: The operation was aborted due to timeout (model=${model}, url=${cleanUrl})`);
    }
    throw err;
  }
}

async function _acquireSlot(): Promise<void> {
  while (_activeCalls >= CONCURRENCY_LIMIT || Date.now() < _pausedUntil) {
    if (Date.now() < _pausedUntil) {
      await new Promise(r => setTimeout(r, Math.max(1000, _pausedUntil - Date.now())));
    } else {
      await new Promise<void>(r => _queue.push(r));
    }
  }
  _activeCalls++;
}

function _releaseSlot(): void {
  _activeCalls--;
  const next = _queue.shift();
  if (next) next();
}

async function _withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    await _acquireSlot();
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = String(err);
      if (msg.includes("429") || msg.toLowerCase().includes("too many requests")) {
        process.stderr.write(`[llm-client] hit rate limit (429), pausing for 60s (attempt ${i + 1}/${attempts})\n`);
        _pausedUntil = Date.now() + 60_000;
        if (i < attempts - 1) {
          _releaseSlot();
          continue;
        }
      }
      throw err;
    } finally {
      _releaseSlot();
    }
  }
  throw new Error("Max retries exceeded");
}

// ── Shared types ──────────────────────────────────────────────────────────────

export interface ToolDef {
  name:        string;
  description: string;
  parameters:  Record<string, unknown>; // JSON Schema "object" type
}

// ── Key resolution ───────────────────────────────────────────────────────────

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

/** Build a RouterProviderSpec from the global llm-* config keys (fallback when no router block). */
export function defaultRouterSpec(): RouterProviderSpec {
  return {
    provider:     cfg.llmProvider as RouterProviderSpec["provider"],
    model:        cfg.llmModel,
    api_key:      cfg.llmApiKey || undefined,
    url:          cfg.llmUrl    || undefined,
    timeout:      cfg.llmTimeout,
    max_attempts: cfg.llmMaxAttempts,
  };
}

// ── Simple call (no tools) ────────────────────────────────────────────────────

/**
 * Single-turn LLM call, no tools. Used by router.ts.
 */
export async function callLlmSimple(
  prompt: string,
  spec:   RouterProviderSpec,
): Promise<string> {
  const attempts = spec.max_attempts ?? cfg.llmMaxAttempts;
  const timeout  = (spec.timeout ?? cfg.llmTimeout) * 1000;

  return _withRetry(() => {
    const apiKey  = resolveApiKey(spec);
    const baseUrl = resolveBaseUrl(spec);
    switch (spec.provider) {
      case "anthropic": return _callAnthropicSimple(prompt, spec.model, apiKey, baseUrl, timeout, spec.max_tokens);
      case "openai":    return _callOpenAISimple(prompt, spec.model, apiKey, baseUrl, timeout, spec.max_tokens);
      case "gemini":    return _callGeminiSimple(prompt, spec.model, apiKey, baseUrl, timeout, spec.max_tokens);
      default:          return _callOllamaSimple(prompt, spec.model, baseUrl, timeout);
    }
  }, attempts);
}

async function _callOllamaSimple(prompt: string, model: string, baseUrl: string, timeout: number): Promise<string> {
  const resp = await _fetchWithLogging(`${baseUrl}/api/generate`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ model, prompt, stream: false }),
    signal:  AbortSignal.timeout(timeout),
  }, model);
  if (!resp.ok) { const b = await resp.text().catch(() => ""); throw new Error(`Ollama simple: ${resp.status} — ${b}`); }
  const data = await resp.json() as { response: string };
  return data.response;
}

async function _callOpenAISimple(prompt: string, model: string, apiKey: string, baseUrl: string, timeout: number, maxTokens?: number): Promise<string> {
  const resp = await _fetchWithLogging(`${baseUrl}/v1/chat/completions`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body:    JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens ?? MAX_TOKENS }),
    signal:  AbortSignal.timeout(timeout),
  }, model);
  if (!resp.ok) { const b = await resp.text().catch(() => ""); throw new Error(`OpenAI simple: ${resp.status} — ${b}`); }
  const data = await resp.json() as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message.content ?? "";
}

async function _callAnthropicSimple(prompt: string, model: string, apiKey: string, baseUrl: string, timeout: number, maxTokens?: number): Promise<string> {
  const resp = await _fetchWithLogging(`${baseUrl}/v1/messages`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body:    JSON.stringify({ model, max_tokens: maxTokens ?? MAX_TOKENS, messages: [{ role: "user", content: prompt }] }),
    signal:  AbortSignal.timeout(timeout),
  }, model);
  if (!resp.ok) { const b = await resp.text().catch(() => ""); throw new Error(`Anthropic simple: ${resp.status} — ${b}`); }
  const data = await resp.json() as { content: { type: string; text: string }[] };
  return data.content[0]?.text ?? "";
}

async function _callGeminiSimple(prompt: string, model: string, apiKey: string, baseUrl: string, timeout: number, maxTokens?: number): Promise<string> {
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await _fetchWithLogging(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens ?? MAX_TOKENS } }),
    signal:  AbortSignal.timeout(timeout),
  }, model);
  if (!resp.ok) { const b = await resp.text().catch(() => ""); throw new Error(`Gemini simple: ${resp.status} — ${b}`); }
  const data = await resp.json() as { candidates: { content: { parts: { text: string }[] } }[] };
  return data.candidates[0]?.content.parts[0]?.text ?? "";
}

// ── Tool-enabled call ─────────────────────────────────────────────────────────

/**
 * Single-round tool-calling call.
 */
export async function callLlmWithTools(
  userMessage:  string,
  systemPrompt: string,
  tools:        ToolDef[],
  toolExecutor: (name: string, args: Record<string, unknown>) => Promise<string>,
  spec:         RouterProviderSpec,
): Promise<string> {
  const attempts = spec.max_attempts ?? cfg.llmMaxAttempts;
  const timeout  = (spec.timeout ?? cfg.llmTimeout) * 1000;

  return _withRetry(() => {
    const apiKey  = resolveApiKey(spec);
    const baseUrl = resolveBaseUrl(spec);
    switch (spec.provider) {
      case "anthropic": return _callAnthropicWithTools(userMessage, systemPrompt, tools, toolExecutor, spec.model, apiKey, baseUrl, timeout);
      case "openai":    return _callOpenAIWithTools(userMessage, systemPrompt, tools, toolExecutor, spec.model, apiKey, baseUrl, timeout);
      case "gemini":    return _callGeminiWithTools(userMessage, systemPrompt, tools, toolExecutor, spec.model, apiKey, baseUrl, timeout);
      default:          return _callOllamaWithTools(userMessage, systemPrompt, tools, toolExecutor, spec.model, baseUrl, timeout);
    }
  }, attempts);
}

// ── Ollama tool calling ───────────────────────────────────────────────────────

async function _callOllamaWithTools(
  userMessage:  string,
  systemPrompt: string,
  tools:        ToolDef[],
  toolExecutor: (name: string, args: Record<string, unknown>) => Promise<string>,
  model:        string,
  baseUrl:      string,
  timeout:      number,
): Promise<string> {
  const toolDefs = tools.map(t => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const msgs1 = [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];

  const resp1 = await _fetchWithLogging(`${baseUrl}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: msgs1, tools: toolDefs, stream: false }),
    signal: AbortSignal.timeout(timeout),
  }, model);
  if (!resp1.ok) { const b = await resp1.text().catch(() => ""); throw new Error(`Ollama tools: ${resp1.status} — ${b}`); }
  const data1 = await resp1.json() as { message: { content: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] } };
  const msg1 = data1.message;

  if (!msg1.tool_calls?.length) return msg1.content;

  const tc = msg1.tool_calls[0]!;
  let toolResult: string;
  try {
    toolResult = await toolExecutor(tc.function.name, tc.function.arguments);
  } catch (err: unknown) {
    toolResult = JSON.stringify({ error: String(err) });
  }

  const msgs2 = [...msgs1, { role: "assistant", content: msg1.content, tool_calls: msg1.tool_calls }, { role: "tool", content: toolResult }];
  const resp2 = await _fetchWithLogging(`${baseUrl}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: msgs2, stream: false }),
    signal: AbortSignal.timeout(timeout),
  }, model);
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
  timeout:      number,
): Promise<string> {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  const toolDefs = tools.map(t => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const msgs1 = [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];

  const resp1 = await _fetchWithLogging(`${baseUrl}/v1/chat/completions`, {
    method: "POST", headers,
    body: JSON.stringify({ model, messages: msgs1, tools: toolDefs, max_tokens: MAX_TOKENS }),
    signal: AbortSignal.timeout(timeout),
  }, model);
  if (!resp1.ok) { const b = await resp1.text().catch(() => ""); throw new Error(`OpenAI tools: ${resp1.status} — ${b}`); }
  const data1 = await resp1.json() as { choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
  const msg1 = data1.choices[0]?.message;
  if (!msg1) return "";

  if (!msg1.tool_calls?.length) return msg1.content ?? "";

  const tc = msg1.tool_calls[0]!;
  let toolArgs: Record<string, unknown>;
  try {
    toolArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
  } catch {
    throw new Error(`OpenAI tool call: invalid JSON in arguments: ${tc.function.arguments}`);
  }
  let toolResult: string;
  try {
    toolResult = await toolExecutor(tc.function.name, toolArgs);
  } catch (err: unknown) {
    toolResult = JSON.stringify({ error: String(err) });
  }

  const msgs2 = [...msgs1, msg1, { role: "tool", tool_call_id: tc.id, content: toolResult }];
  const resp2 = await _fetchWithLogging(`${baseUrl}/v1/chat/completions`, {
    method: "POST", headers,
    body: JSON.stringify({ model, messages: msgs2, max_tokens: MAX_TOKENS }),
    signal: AbortSignal.timeout(timeout),
  }, model);
  if (!resp2.ok) { const b = await resp2.text().catch(() => ""); throw new Error(`OpenAI tool result: ${resp2.status} — ${b}`); }
  const data2 = await resp2.json() as { choices: { message: { content: string } }[] };
  return data2.choices[0]?.message.content ?? "";
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
  timeout:      number,
): Promise<string> {
  const headers = { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  const toolDefs = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));

  const resp1 = await _fetchWithLogging(`${baseUrl}/v1/messages`, {
    method: "POST", headers,
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system: systemPrompt, tools: toolDefs, messages: [{ role: "user", content: userMessage }] }),
    signal: AbortSignal.timeout(timeout),
  }, model);
  if (!resp1.ok) { const b = await resp1.text().catch(() => ""); throw new Error(`Anthropic tools: ${resp1.status} — ${b}`); }
  const data1 = await resp1.json() as { content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]; stop_reason: string };

  const toolUse = data1.content.find(c => c.type === "tool_use");
  if (!toolUse?.id || !toolUse.name) {
    return data1.content.find(c => c.type === "text")?.text ?? "";
  }

  let toolResult: string;
  try {
    toolResult = await toolExecutor(toolUse.name, toolUse.input ?? {});
  } catch (err: unknown) {
    toolResult = JSON.stringify({ error: String(err) });
  }

  const resp2 = await _fetchWithLogging(`${baseUrl}/v1/messages`, {
    method: "POST", headers,
    body: JSON.stringify({
      model, max_tokens: MAX_TOKENS, system: systemPrompt, tools: toolDefs,
      messages: [
        { role: "user",      content: userMessage },
        { role: "assistant", content: data1.content },
        { role: "user",      content: [{ type: "tool_result", tool_use_id: toolUse.id, content: toolResult }] },
      ],
    }),
    signal: AbortSignal.timeout(timeout),
  }, model);
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
  timeout:      number,
): Promise<string> {
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const toolDefs = { tools: [{ function_declarations: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }] };
  const genCfg = { generationConfig: { maxOutputTokens: MAX_TOKENS } };

  // Gemini: system prompt prepended to the first user turn
  const contents1 = [{ role: "user", parts: [{ text: `${systemPrompt}\n\n${userMessage}` }] }];

  const resp1 = await _fetchWithLogging(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: contents1, ...toolDefs, ...genCfg }),
    signal: AbortSignal.timeout(timeout),
  }, model);
  if (!resp1.ok) { const b = await resp1.text().catch(() => ""); throw new Error(`Gemini tools: ${resp1.status} — ${b}`); }
  const data1 = await resp1.json() as {
    candidates: { content: { role: string; parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }> } }[];
  };

  const parts1 = data1.candidates[0]?.content.parts ?? [];
  const fcPart = parts1.find(p => p.functionCall);
  if (!fcPart?.functionCall) return parts1.find(p => p.text)?.text ?? "";

  const fc = fcPart.functionCall;
  let toolResult: string;
  try {
    toolResult = await toolExecutor(fc.name, fc.args);
  } catch (err: unknown) {
    toolResult = JSON.stringify({ error: String(err) });
  }

  const contents2 = [
    ...contents1,
    { role: "model", parts: [{ functionCall: { name: fc.name, args: fc.args } }] },
    { role: "user",  parts: [{ functionResponse: { name: fc.name, response: { content: toolResult } } }] },
  ];

  const resp2 = await _fetchWithLogging(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: contents2, ...toolDefs, ...genCfg }),
    signal: AbortSignal.timeout(timeout),
  }, model);
  if (!resp2.ok) { const b = await resp2.text().catch(() => ""); throw new Error(`Gemini tool result: ${resp2.status} — ${b}`); }
  const data2 = await resp2.json() as { candidates: { content: { parts: { text?: string }[] } }[] };
  return data2.candidates[0]?.content.parts.find(p => p.text)?.text ?? "";
}

// ── Single-turn tool structured output ────────────────────────────────────────

/**
 * Invokes an LLM with a single tool and returns the JSON arguments if the tool is called.
 * Does not execute the tool or continue the conversation.
 */
export async function callLlmTool(
  prompt: string,
  tool: ToolDef,
  spec: RouterProviderSpec,
): Promise<Record<string, unknown> | null> {
  const attempts = spec.max_attempts ?? cfg.llmMaxAttempts;
  const timeout  = (spec.timeout ?? cfg.llmTimeout) * 1000;

  return _withRetry(() => {
    const apiKey  = resolveApiKey(spec);
    const baseUrl = resolveBaseUrl(spec);
    switch (spec.provider) {
      case "anthropic": return _callAnthropicTool(prompt, tool, spec.model, apiKey, baseUrl, timeout);
      case "openai":    return _callOpenAITool(prompt, tool, spec.model, apiKey, baseUrl, timeout);
      case "gemini":    return _callGeminiTool(prompt, tool, spec.model, apiKey, baseUrl, timeout);
      default:          return _callOllamaTool(prompt, tool, spec.model, baseUrl, timeout);
    }
  }, attempts);
}

async function _callOllamaTool(prompt: string, tool: ToolDef, model: string, baseUrl: string, timeout: number): Promise<Record<string, unknown> | null> {
  const toolDefs = [{ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } }];
  const msgs = [{ role: "user", content: prompt }];
  const resp = await _fetchWithLogging(`${baseUrl}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: msgs, tools: toolDefs, stream: false }),
    signal: AbortSignal.timeout(timeout),
  }, model);
  if (!resp.ok) { const b = await resp.text().catch(() => ""); throw new Error(`Ollama tool structured: ${resp.status} — ${b}`); }
  const data = await resp.json() as { message: { tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] } };
  const tc = data.message.tool_calls?.[0];
  if (tc?.function.name === tool.name) return tc.function.arguments;
  return null;
}

async function _callOpenAITool(prompt: string, tool: ToolDef, model: string, apiKey: string, baseUrl: string, timeout: number): Promise<Record<string, unknown> | null> {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  const toolDefs = [{ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } }];
  const msgs = [{ role: "user", content: prompt }];
  const resp = await _fetchWithLogging(`${baseUrl}/v1/chat/completions`, {
    method: "POST", headers,
    body: JSON.stringify({ model, messages: msgs, tools: toolDefs, tool_choice: { type: "function", function: { name: tool.name } }, max_tokens: MAX_TOKENS }),
    signal: AbortSignal.timeout(timeout),
  }, model);
  if (!resp.ok) { const b = await resp.text().catch(() => ""); throw new Error(`OpenAI tool structured: ${resp.status} — ${b}`); }
  const data = await resp.json() as { choices: { message: { tool_calls?: { function: { name: string; arguments: string } }[] } }[] };
  const tc = data.choices[0]?.message.tool_calls?.[0];
  if (tc?.function.name === tool.name) {
    try { return JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { return null; }
  }
  return null;
}

async function _callAnthropicTool(prompt: string, tool: ToolDef, model: string, apiKey: string, baseUrl: string, timeout: number): Promise<Record<string, unknown> | null> {
  const headers = { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  const toolDefs = [{ name: tool.name, description: tool.description, input_schema: tool.parameters }];
  const resp = await _fetchWithLogging(`${baseUrl}/v1/messages`, {
    method: "POST", headers,
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, tools: toolDefs, tool_choice: { type: "tool", name: tool.name }, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(timeout),
  }, model);
  if (!resp.ok) { const b = await resp.text().catch(() => ""); throw new Error(`Anthropic tool structured: ${resp.status} — ${b}`); }
  const data = await resp.json() as { content: { type: string; name?: string; input?: Record<string, unknown> }[] };
  const toolUse = data.content.find(c => c.type === "tool_use" && c.name === tool.name);
  return toolUse?.input ?? null;
}

async function _callGeminiTool(prompt: string, tool: ToolDef, model: string, apiKey: string, baseUrl: string, timeout: number): Promise<Record<string, unknown> | null> {
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const toolDefs = { tools: [{ function_declarations: [{ name: tool.name, description: tool.description, parameters: tool.parameters }] }] };
  const toolConfig = { toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [tool.name] } } };
  const genCfg = { generationConfig: { maxOutputTokens: MAX_TOKENS } };
  const contents = [{ role: "user", parts: [{ text: prompt }] }];
  const resp = await _fetchWithLogging(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, ...toolDefs, ...toolConfig, ...genCfg }),
    signal: AbortSignal.timeout(timeout),
  }, model);
  if (!resp.ok) { const b = await resp.text().catch(() => ""); throw new Error(`Gemini tool structured: ${resp.status} — ${b}`); }
  const data = await resp.json() as { candidates: { content: { parts: Array<{ functionCall?: { name: string; args: Record<string, unknown> } }> } }[] };
  const fcPart = data.candidates[0]?.content.parts?.find(p => p.functionCall);
  if (fcPart?.functionCall?.name === tool.name) return fcPart.functionCall.args;
  return null;
}
