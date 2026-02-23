import { cfg } from "../config.js";
import { qd, COLLECTIONS } from "../qdrant.js";
import { topAccessed } from "../redis.js";

export async function statsTool(): Promise<string> {
  const lines = [
    `Memory Stats | Agent: ${cfg.agentId} | Project: ${cfg.projectId}\n`,
  ];

  const collectionLines = await Promise.all(
    COLLECTIONS.map((col) =>
      qd
        .getCollection(col)
        .then((info: { points_count?: number | null }) => `  ${col.padEnd(25)}: ${info.points_count ?? 0} points`)
        .catch(() => `  ${col.padEnd(25)}: N/A`)
    )
  );
  lines.push(...collectionLines);

  const top = await topAccessed(cfg.projectId).catch((): never[] => []);
  if (top.length > 0) {
    lines.push("\nMost accessed:");
    for (const { id, memoryType, accessCount } of top) {
      lines.push(`  ${id} [${memoryType}] x${accessCount}`);
    }
  }

  return lines.join("\n");
}
