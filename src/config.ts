import { parseArgs } from "node:util";

// pnpm passes its own "--" separator into process.argv when using
// `pnpm <script> -- <args>`.  Strip it so that named options that follow
// are not silently treated as positionals by parseArgs.
const rawArgs = process.argv.slice(2).filter((a) => a !== "--");

const { values } = parseArgs({
  args: rawArgs,
  options: {
    "qdrant-url":     { type: "string", default: "http://localhost:6333" },
    "ollama-url":     { type: "string", default: "http://localhost:11434" },
    "embed-model":    { type: "string", default: "mxbai-embed-large" },
    "embed-dim":      { type: "string", default: "1024" },
    "redis-url":      { type: "string", default: "redis://localhost:6379" },
    "agent-id":       { type: "string", default: "default" },
    "project-id":     { type: "string", default: "default" },
    "llm-model":      { type: "string", default: "gemma3n:e2b" },
    "project-root":   { type: "string", default: "" },
  },
  allowPositionals: true,
  strict: false,
});

export const cfg = Object.freeze({
  qdrantUrl:   values["qdrant-url"]   as string,
  ollamaUrl:   values["ollama-url"]   as string,
  embedModel:  values["embed-model"]  as string,
  embedDim:    parseInt(values["embed-dim"] as string, 10),
  redisUrl:    values["redis-url"]    as string,
  agentId:     values["agent-id"]     as string,
  projectId:   values["project-id"]  as string,
  llmModel:    values["llm-model"]    as string,
  projectRoot: values["project-root"] as string,
});
process.stderr.write(`[config] projectId=${cfg.projectId} projectRoot=${cfg.projectRoot || "(cwd)"}\n`);
