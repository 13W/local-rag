import { QdrantClient } from "@qdrant/js-client-rest";
import { cfg } from "./config.js";

export const qd = new QdrantClient({ url: cfg.qdrantUrl });

export const COLLECTIONS = [
  "memory_episodic",
  "memory_semantic",
  "memory_procedural",
  "code_chunks",
] as const;

export async function ensureCollections(): Promise<void> {
  const { collections } = await qd.getCollections();
  const existing = new Set(collections.map((c) => c.name));

  for (const name of COLLECTIONS) {
    if (existing.has(name)) continue;

    await qd.createCollection(name, {
      vectors: { size: cfg.embedDim, distance: "Cosine" },
    });

    for (const field of ["project_id", "agent_id", "scope", "content_hash"]) {
      await qd.createPayloadIndex(name, {
        field_name: field,
        field_schema: "keyword",
        wait: true,
      });
    }

    if (name === "code_chunks") {
      for (const field of ["file_path", "chunk_type", "language"]) {
        await qd.createPayloadIndex(name, {
          field_name: field,
          field_schema: "keyword",
          wait: true,
        });
      }
    }

    process.stderr.write(`[qdrant] Created collection: ${name}\n`);
  }
}
