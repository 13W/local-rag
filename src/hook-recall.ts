import { debugLog } from "./util.js";
import { runArchivist } from "./archivist.js";

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end",  ()      => resolve(buf));
  });
}

export async function runHookRecall(): Promise<void> {
  try {
    const raw   = await readStdin();
    const input = JSON.parse(raw.trim() || "{}") as { prompt?: string };
    const prompt = (input.prompt ?? "").trim();

    if (!prompt) {
      process.stdout.write('{"systemMessage":""}\n');
      return;
    }

    debugLog("hook-recall", `prompt="${prompt.slice(0, 100)}"`);

    const systemMessage = await runArchivist(prompt);
    process.stdout.write(JSON.stringify({ systemMessage }) + "\n");
  } catch {
    process.stdout.write('{"systemMessage":""}\n');
  }
}
