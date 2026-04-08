
import { Status } from "../src/types.js";

const VALID_STATUSES = new Set<string>(["in_progress", "resolved", "open_question", "hypothesis"]);

interface RouterOp {
  text:       string;
  status:     Status;
  confidence: number;
}

// Копия функции из src/router.ts для теста
function parseOps(raw: string): RouterOp[] {
  const candidates: string[] = [];
  
  const arrayRe = /\[[\s\S]*?\]/g;
  let m: RegExpExecArray | null;
  while ((m = arrayRe.exec(raw)) !== null) candidates.push(m[0]);

  if (candidates.length === 0) {
    const objRe = /\{[\s\S]*?\}/g;
    while ((m = objRe.exec(raw)) !== null) candidates.push(m[0]);
  }

  const firstBracket = Math.min(
    raw.indexOf("[") === -1 ? Infinity : raw.indexOf("["),
    raw.indexOf("{") === -1 ? Infinity : raw.indexOf("{")
  );
  if (firstBracket !== Infinity) {
    candidates.push(raw.slice(firstBracket));
  }

  let parsed: unknown[] = [];
  let found = false;
  const sorted = candidates.sort((a, b) => b.length - a.length);

  for (const candidate of sorted) {
    try {
      const p = JSON.parse(candidate);
      if (Array.isArray(p)) {
        parsed = p;
        found = true;
        break;
      }
      if (typeof p === "object" && p !== null) {
        parsed = [p];
        found = true;
        break;
      }
    } catch {
      try {
        if (candidate.startsWith("[")) {
          parsed = JSON.parse(candidate + "]") as unknown[];
          found = true;
          break;
        }
      } catch { /* skip */ }
    }
  }

  if (!found) return [];

  return (parsed as any[]).flatMap((item) => {
    if (typeof item !== "object" || !item) return [];
    const o = item as Record<string, any>;
    const text = String(o["text"] ?? "").trim();
    if (!text) return [];
    const status = String(o["status"] ?? "");
    if (!VALID_STATUSES.has(status)) return [];
    const confidence = Number(o["confidence"] ?? 0);
    if (isNaN(confidence) || confidence < 0.4) return [];
    return [{ text, status: status as Status, confidence }];
  });
}

// Тестовые случаи
const CASES = [
  {
    name: "Chatty with preamble",
    input: `* Role: Memory extraction system
* Task: Extract insights

Here is the JSON:
[
  {"text": "Found a bug in Gemini enum handling", "status": "resolved", "confidence": 0.9}
]`
  },
  {
    name: "Object list instead of array",
    input: `I found these:
{"text": "Task A", "status": "in_progress", "confidence": 0.8}
{"text": "Task B", "status": "open_question", "confidence": 0.7}`
  },
  {
    name: "Truncated JSON array",
    input: `Progress so far:
[
  {"text": "Partially written", "status": "hypothesis", "confidence": 0.5}`
  }
];

console.log("--- Testing parseOps improvement ---");
for (const c of CASES) {
  const ops = parseOps(c.input);
  console.log(`\nCase: ${c.name}`);
  console.log(`Input length: ${c.input.length}`);
  console.log(`Result: ${JSON.stringify(ops, null, 2)}`);
  if (ops.length === 0) console.error("FAILED: No ops extracted!");
}
