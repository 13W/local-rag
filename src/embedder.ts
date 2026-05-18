import { cfg } from "./config.js";
import { callLlmSimple, defaultRouterSpec } from "./llm-client.js";
import { Queue } from "./queue.js";

// ── Embed rate-limit queue ─────────────────────────────────────────────────────
// Used only for Gemini (embedContent = 1 HTTP request per text).
// Default: 90 req/60 s (conservative, free tier is 100 RPM).
// Call applyEmbedRateLimit() to override from server config.

let _embedQueue = new Queue(90, 60);

const MAX_RETRY_AFTER_MS = 30_000;

export function applyEmbedRateLimit(size: number, window: number): void {
  _embedQueue = new Queue(size, window);
}

// ── Embedding ──────────────────────────────────────────────────────────────────

function resolveEmbedUrl(): string {
  return cfg.embedUrl || (
    cfg.embedProvider === "openai"  ? "https://api.openai.com"
  : cfg.embedProvider === "voyage" ? "https://api.voyageai.com"
  : cfg.embedProvider === "gemini" ? "https://generativelanguage.googleapis.com"
  : cfg.ollamaUrl
  );
}

function resolveEmbedApiKey(): string {
  return cfg.embedApiKey
    || process.env["GEMINI_API_KEY"]
    || process.env["GOOGLE_API_KEY"]
    || "";
}

async function embedOllama(texts: string[], baseUrl: string, timeout: number): Promise<number[][]> {
  const resp = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.embedModel, input: texts }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return Promise.reject(new Error(`Embed failed: ${resp.status} ${resp.statusText} — ${body}`));
  }
  const data = (await resp.json()) as { embeddings: number[][] };
  return data.embeddings;
}

async function embedOpenAI(texts: string[], baseUrl: string, timeout: number): Promise<number[][]> {
  const resp = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.embedApiKey}` },
    body: JSON.stringify({ model: cfg.embedModel, input: texts }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return Promise.reject(new Error(`Embed failed: ${resp.status} ${resp.statusText} — ${body}`));
  }
  const data = (await resp.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => d.embedding);
}

async function embedVoyage(texts: string[], baseUrl: string, timeout: number): Promise<number[][]> {
  const resp = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.embedApiKey}` },
    body: JSON.stringify({ model: cfg.embedModel, input: texts }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return Promise.reject(new Error(`Embed failed: ${resp.status} ${resp.statusText} — ${body}`));
  }
  const data = (await resp.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => d.embedding);
}

// Gemini embedContent API — one request per text (gemini-embedding-* models do not
// support batchEmbedContents; only the legacy text-embedding-* models do).
// Each request goes through _embedQueue to respect the RPM rate limit.
async function embedGemini(texts: string[], baseUrl: string, timeout: number): Promise<number[][]> {
  const apiKey    = resolveEmbedApiKey();
  const model     = cfg.embedModel;
  const modelPath = model.startsWith("models/") ? model : `models/${model}`;
  const url       = `${baseUrl}/v1beta/${modelPath}:embedContent?key=${encodeURIComponent(apiKey)}`;

  const allVecs: number[][] = [];
  // outputDimensionality truncates the vector to match the configured collection size.
  // Required when the model's native dim (e.g. 3072 for gemini-embedding-001) differs
  // from the Qdrant collection dim (cfg.embedDim).
  const reqBody = (text: string) => JSON.stringify({
    content:              { parts: [{ text }] },
    outputDimensionality: cfg.embedDim,
  });

  const doFetch = (text: string) => fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    reqBody(text),
    signal:  AbortSignal.timeout(timeout),
  });

  for (const text of texts) {
    let pushed = false;
    // Retry loop: handles consecutive 429/503 responses by pausing the queue
    // and re-acquiring before each attempt. Up to 10 retries.
    for (let attempt = 0; attempt < 10; attempt++) {
      // Honour rate limit; also respects any active pause (from a prior 429).
      await _embedQueue.acquire();

      const resp = await doFetch(text);

      if (resp.status === 429 || resp.status === 503) {
        const body = await resp.text().catch(() => "");
        // Parse provider-supplied retry delay ("retry in Xs") when present.
        const m      = body.match(/retry[^\d]*?(\d+(?:\.\d+)?)\s*s/i);
        const waitMs = Math.min(
          m ? Math.ceil(parseFloat(m[1]!) * 1000) + 500 : 60_000,
          MAX_RETRY_AFTER_MS,
        );
        process.stderr.write(
          `[embedder] rate limit (${resp.status}), pausing ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 1})\n`
        );
        _embedQueue.pause(waitMs);
        continue; // re-acquire after pause and retry
      }

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        process.stderr.write(
          `[embedder] Gemini error ${resp.status}: text_len=${text.length} text_preview=${JSON.stringify(text.slice(0, 80))}\n`
        );
        return Promise.reject(new Error(`Embed failed: ${resp.status} ${resp.statusText} — ${body}`));
      }

      const data = (await resp.json()) as { embedding: { values: number[] } };
      allVecs.push(data.embedding.values);
      pushed = true;
      break;
    }
    if (!pushed) {
      return Promise.reject(new Error("Embed failed: max retries exceeded (rate limit)"));
    }
  }

  return allVecs;
}

function embedBatchAttempt(texts: string[], attempt: number): Promise<number[][]> {
  const baseUrl = resolveEmbedUrl();
  const timeout = cfg.embedTimeout * 1000;
  const providerFn =
    cfg.embedProvider === "openai"  ? embedOpenAI
  : cfg.embedProvider === "voyage" ? embedVoyage
  : cfg.embedProvider === "gemini" ? embedGemini
  : embedOllama;
  return providerFn(texts, baseUrl, timeout).catch((err: unknown) => {
    if (attempt >= cfg.embedMaxAttempts - 1) return Promise.reject(err);
    return new Promise<void>((r) => setTimeout(r, (attempt + 1) * 1000))
      .then(() => embedBatchAttempt(texts, attempt + 1));
  });
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const truncated = texts.map((t) =>
    t.length > cfg.embedMaxChars ? t.slice(0, cfg.embedMaxChars) : t
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

export function callLlm(prompt: string, maxTokens: number): Promise<string> {
  const spec = { ...defaultRouterSpec(), max_tokens: maxTokens };
  return callLlmSimple(prompt, spec);
}

/**
 * Generate a 1-2 sentence English description of a code chunk using the LLM.
 * Returns empty string on failure.\n */
export function generateDescription(chunk: {
  content:   string;
  name:      string;
  chunkType: string;
  language:  string;
}): Promise<string> {
  const preview = chunk.content.slice(0, 600);
  const prompt =
    `Describe briefly in 1-2 sentences what this ${chunk.language} ${chunk.chunkType} ` +
    `"${chunk.name}" does:\\n\\n${preview}`;
  return callLlm(prompt, 200)
    .then((text) => text.trim().slice(0, 3000));
}

export type Candidate = [number, string, string | number, string, string, string, string];

export function llmFilter(
  query: string,
  candidates: Candidate[]
): Promise<Candidate[]> {
  if (candidates.length === 0) return Promise.resolve(candidates);

  const lines = candidates.map((c, i) => `[${i}] ${c[3].slice(0, 300)}`);
  const prompt =
    `Query: "${query}"\\n\\n` +
    `Memory entries:\\n` +
    lines.join("\\n") +
    `\\n\\nReturn a JSON array of indices of entries that are ACTUALLY relevant to the query. ` +
    `If none are relevant return []. Example: [0, 2]`;

  return callLlm(prompt, 256)
    .then((text) => {
      const m = text.trim().match(/\\[[\\d,\\s]*\\]/);
      if (!m) {
        process.stderr.write(`[embedder] llmFilter: no JSON array in response — keeping all\\n`);
        return candidates;
      }
      const indices: unknown[] = JSON.parse(m[0]) as unknown[];
      return indices
        .filter((i): i is number => typeof i === "number" && i >= 0 && i < candidates.length)
        .map((i) => candidates[i]!);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[embedder] llmFilter ${msg} — returning unfiltered\\n`);
      return candidates;
    });
}
