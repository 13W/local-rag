// Cross-encoder reranking is disabled: @huggingface/transformers is not supported on FreeBSD.
import type { Schemas } from "@qdrant/js-client-rest";

type ScoredPoint = Schemas["ScoredPoint"];

export async function rerank(
  _query: string,
  hits: ScoredPoint[],
  topK: number,
): Promise<ScoredPoint[]> {
  process.stderr.write("[reranker] disabled on this platform (FreeBSD)\n");
  return hits.slice(0, topK);
}
