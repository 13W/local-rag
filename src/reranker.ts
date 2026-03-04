import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
} from "@huggingface/transformers";
import type { Schemas } from "@qdrant/js-client-rest";

type ScoredPoint = Schemas["ScoredPoint"];

const MODEL = "Xenova/bge-reranker-base";

interface Singleton {
  tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
  model: Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>;
}
let _singleton: Singleton | null = null;

async function getSingleton(): Promise<Singleton> {
  if (!_singleton) {
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(MODEL),
      AutoModelForSequenceClassification.from_pretrained(MODEL),
    ]);
    _singleton = { tokenizer, model };
  }
  return _singleton;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export async function rerank(
  query: string,
  hits: ScoredPoint[],
  topK: number,
): Promise<ScoredPoint[]> {
  if (hits.length === 0) return hits;

  const { tokenizer, model } = await getSingleton();

  const docs = hits.map(h => {
    const p = (h.payload ?? {}) as Record<string, unknown>;
    return String(p["content"] ?? "").slice(0, 512);
  });

  // Tokenize all (query, doc) pairs as a single batch
  const inputs = await (tokenizer as unknown as (
    text: string[],
    opts: { text_pair: string[]; padding: boolean; truncation: boolean; max_length: number }
  ) => Promise<unknown>)(
    Array(docs.length).fill(query),
    { text_pair: docs, padding: true, truncation: true, max_length: 512 },
  );

  // Model outputs { logits: Tensor }, logits.data is flat Float32Array of length = batch_size
  // (bge-reranker-base has num_labels=1, so one score per pair)
  const output = await (model as unknown as (
    input: unknown
  ) => Promise<{ logits: { data: ArrayLike<number> } }>)(inputs);

  const logitsArr = Array.from(output.logits.data);

  return hits
    .map((h, i) => ({ ...h, score: sigmoid(logitsArr[i] ?? 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
