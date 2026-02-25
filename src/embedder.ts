import { cfg } from "./config.js";

const MAX_CHARS = 800;

// ── Embedding ──────────────────────────────────────────────────────────────────

function resolveEmbedUrl(): string {
  return cfg.embedUrl || (
    cfg.embedProvider === "openai"  ? "https://api.openai.com"
  : cfg.embedProvider === "voyage" ? "https://api.voyageai.com"
  : cfg.ollamaUrl
  );
}

async function embedOllama(texts: string[], baseUrl: string): Promise<number[][]> {
  const resp = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.embedModel, input: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return Promise.reject(new Error(`Embed failed: ${resp.status} ${resp.statusText} — ${body}`));
  }
  const data = (await resp.json()) as { embeddings: number[][] };
  return data.embeddings;
}

async function embedOpenAI(texts: string[], baseUrl: string): Promise<number[][]> {
  const resp = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.embedApiKey}` },
    body: JSON.stringify({ model: cfg.embedModel, input: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return Promise.reject(new Error(`Embed failed: ${resp.status} ${resp.statusText} — ${body}`));
  }
  const data = (await resp.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => d.embedding);
}

async function embedVoyage(texts: string[], baseUrl: string): Promise<number[][]> {
  const resp = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.embedApiKey}` },
    body: JSON.stringify({ model: cfg.embedModel, input: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return Promise.reject(new Error(`Embed failed: ${resp.status} ${resp.statusText} — ${body}`));
  }
  const data = (await resp.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => d.embedding);
}

function embedBatchAttempt(texts: string[], attempt: number): Promise<number[][]> {
  const baseUrl = resolveEmbedUrl();
  const providerFn =
    cfg.embedProvider === "openai"  ? embedOpenAI
  : cfg.embedProvider === "voyage" ? embedVoyage
  : embedOllama;
  return providerFn(texts, baseUrl).catch((err: unknown) => {
    if (attempt >= 2) return Promise.reject(err);
    return new Promise<void>((r) => setTimeout(r, (attempt + 1) * 1000))
      .then(() => embedBatchAttempt(texts, attempt + 1));
  });
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const truncated = texts.map((t) =>
    t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t
  );
  return embedBatchAttempt(truncated, 0);
}

export async function embedOne(text: string): Promise<number[]> {
  const results = await embedBatch([text]);
  const first = results[0];
  if (!first) return Promise.reject(new Error("Empty embedding result"));
  return first;
}

// ── LLM ───────────────────────────────────────────────────────────────────────

function resolveLlmUrl(): string {
  return cfg.llmUrl || (
    cfg.llmProvider === "anthropic" ? "https://api.anthropic.com"
  : cfg.llmProvider === "openai"   ? "https://api.openai.com"
  : cfg.ollamaUrl
  );
}

async function callLlmOllama(prompt: string, _maxTokens: number): Promise<string> {
  const resp = await fetch(`${resolveLlmUrl()}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.llmModel, prompt, stream: false }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return Promise.reject(new Error(`LLM failed: ${resp.status} ${resp.statusText} (model=${cfg.llmModel}) — ${body}`));
  }
  const data = (await resp.json()) as { response: string };
  return data.response;
}

async function callLlmOpenAI(prompt: string, maxTokens: number): Promise<string> {
  const resp = await fetch(`${resolveLlmUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.llmApiKey}` },
    body: JSON.stringify({ model: cfg.llmModel, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return Promise.reject(new Error(`LLM failed: ${resp.status} ${resp.statusText} (model=${cfg.llmModel}) — ${body}`));
  }
  const data = (await resp.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]!.message.content;
}

async function callLlmAnthropic(prompt: string, maxTokens: number): Promise<string> {
  const resp = await fetch(`${resolveLlmUrl()}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.llmApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: cfg.llmModel, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return Promise.reject(new Error(`LLM failed: ${resp.status} ${resp.statusText} (model=${cfg.llmModel}) — ${body}`));
  }
  const data = (await resp.json()) as { content: { type: string; text: string }[] };
  return data.content[0]!.text;
}

function callLlm(prompt: string, maxTokens: number): Promise<string> {
  const fn =
    cfg.llmProvider === "anthropic" ? callLlmAnthropic
  : cfg.llmProvider === "openai"   ? callLlmOpenAI
  : callLlmOllama;
  return fn(prompt, maxTokens);
}

/**
 * Generate a 1-2 sentence English description of a code chunk using the LLM.
 * Returns empty string on failure.
 */
export function generateDescription(chunk: {
  content:   string;
  name:      string;
  chunkType: string;
  language:  string;
}): Promise<string> {
  const preview = chunk.content.slice(0, 600);
  const prompt =
    `Describe briefly in 1-2 sentences what this ${chunk.language} ${chunk.chunkType} ` +
    `"${chunk.name}" does:\n\n${preview}`;
  return callLlm(prompt, 200)
    .then((text) => text.trim().slice(0, 500));
}

export type Candidate = [number, string, string | number, string, string, string];

export function llmFilter(
  query: string,
  candidates: Candidate[]
): Promise<Candidate[]> {
  if (candidates.length === 0) return Promise.resolve(candidates);

  const lines = candidates.map((c, i) => `[${i}] ${c[3].slice(0, 300)}`);
  const prompt =
    `Query: "${query}"\n\n` +
    `Memory entries:\n` +
    lines.join("\n") +
    `\n\nReturn a JSON array of indices of entries that are ACTUALLY relevant to the query. ` +
    `If none are relevant return []. Example: [0, 2]`;

  return callLlm(prompt, 256)
    .then((text) => {
      const m = text.trim().match(/\[[\d,\s]*\]/);
      if (!m) {
        process.stderr.write(`[embedder] llmFilter: no JSON array in response — keeping all\n`);
        return candidates;
      }
      const indices: unknown[] = JSON.parse(m[0]) as unknown[];
      return indices
        .filter((i): i is number => typeof i === "number" && i >= 0 && i < candidates.length)
        .map((i) => candidates[i]!);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[embedder] llmFilter ${msg} — returning unfiltered\n`);
      return candidates;
    });
}
