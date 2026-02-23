import { cfg } from "./config.js";

const MAX_CHARS = 800;

async function embedBatchAttempt(texts: string[], attempt: number): Promise<number[][]> {
  const resp = await fetch(`${cfg.ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.embedModel, input: texts }),
    signal: AbortSignal.timeout(60_000),
  });

  if (resp.ok) {
    const data = (await resp.json()) as { embeddings: number[][] };
    return data.embeddings;
  }

  if (resp.status === 404 || attempt >= 2) {
    const body = await resp.text().catch(() => "");
    return Promise.reject(
      new Error(`Embed failed: ${resp.status} ${resp.statusText} — ${body}`)
    );
  }

  await new Promise<void>((r) => setTimeout(r, (attempt + 1) * 1000));
  return embedBatchAttempt(texts, attempt + 1);
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

export type Candidate = [number, string, string | number, string, string, string];

export async function llmFilter(
  query: string,
  candidates: Candidate[]
): Promise<Candidate[]> {
  if (candidates.length === 0) return candidates;

  const lines = candidates.map((c, i) => `[${i}] ${c[3].slice(0, 300)}`);
  const prompt =
    `Query: "${query}"\n\n` +
    `Memory entries:\n` +
    lines.join("\n") +
    `\n\nReturn a JSON array of indices of entries that are ACTUALLY relevant to the query. ` +
    `If none are relevant return []. Example: [0, 2]`;

  const resp = await fetch(`${cfg.ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.llmModel, prompt, stream: false }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!resp.ok) {
    process.stderr.write(
      `[embedder] llmFilter HTTP ${resp.status} — returning unfiltered\n`
    );
    return candidates;
  }

  const data = (await resp.json()) as { response: string };
  const m = data.response.trim().match(/\[[\d,\s]*\]/);
  if (!m) {
    process.stderr.write(`[embedder] llmFilter: no JSON array in response — keeping all\n`);
    return candidates;
  }

  const indices: unknown[] = JSON.parse(m[0]) as unknown[];
  return indices
    .filter((i): i is number => typeof i === "number" && i >= 0 && i < candidates.length)
    .map((i) => candidates[i]!);
}
