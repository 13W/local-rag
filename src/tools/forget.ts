import { qd } from "../qdrant.js";
import { getMemoryMeta, deleteById } from "../redis.js";
import { colForType } from "../util.js";

export interface ForgetArgs {
  memory_id: string;
}

export async function forgetTool(a: ForgetArgs): Promise<string> {
  const meta = await getMemoryMeta(a.memory_id);
  if (!meta) return `not found: ${a.memory_id}`;

  const col = colForType(meta.memoryType);
  await qd.delete(col, { points: [a.memory_id] });
  await deleteById(a.memory_id);
  return `deleted: ${a.memory_id}`;
}
