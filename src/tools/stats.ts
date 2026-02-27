import { cfg } from "../config.js";
import { qd, COLLECTIONS, colName } from "../qdrant.js";
import { topAccessed } from "../storage.js";

export async function statsTool(): Promise<string> {
  const lines = [
    `Memory Stats | Agent: ${cfg.agentId} | Project: ${cfg.projectId}\n`,
  ];

  const projectFilter = {
    must: [{ key: "project_id", match: { value: cfg.projectId } }],
  };

  const collectionLines = await Promise.all(
    COLLECTIONS.map((col) =>
      qd
        .count(colName(col), { filter: projectFilter })
        .then((result) => `  ${colName(col).padEnd(25)}: ${result.count} points`)
        .catch(() => `  ${colName(col).padEnd(25)}: N/A`)
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
