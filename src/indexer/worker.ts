import { parentPort } from "node:worker_threads";
import { resolve, relative } from "node:path";
import { CodeIndexer } from "./indexer.js";
import { startWatcher } from "./watcher.js";
import { applyServerConfig, cfg } from "../config.js";
import type { ServerConfig, ProjectConfig } from "../server-config.js";
import { existsSync } from "node:fs";
import { getCurrentBranch } from "./git.js";

if (!parentPort) throw new Error("This script must be run as a worker thread.");

let indexer: CodeIndexer | null = null;
let watcherQueue = new Set<string>();
let isPaused = false;
let isIndexing = false;
let currentProjectConfig: ProjectConfig | null = null;
let isInitializing = false;

async function processQueue() {
  if (isPaused || isIndexing || !indexer || !currentProjectConfig) return;
  if (watcherQueue.size === 0) return;

  isIndexing = true;
  const files = Array.from(watcherQueue);
  watcherQueue.clear();

  try {
    const root = indexer.projectRoot || ".";
    const pathBase = resolve(root);

    for (const absPath of files) {
      const relPath = relative(pathBase, absPath).replace(/\\/g, "/");

      if (existsSync(absPath)) {
        const t0 = Date.now();
        const [n, ms] = await indexer.indexFileIncremental(absPath, root).catch((err: unknown) => {
          parentPort!.postMessage({ type: "error", error: `[watcher] error ${relPath}: ${String(err)}` });
          return [0, Date.now() - t0] as [number, number];
        });
        if (n > 0) parentPort!.postMessage({ type: "recordIndex", relPath, chunks: n, ms, ok: true });
      } else {
        const t1 = Date.now();
        await indexer.untagFile(relPath, indexer.branch).catch((err: unknown) => {
          parentPort!.postMessage({ type: "error", error: `[watcher] delete error ${relPath}: ${String(err)}` });
        });
        parentPort!.postMessage({ type: "recordIndex", relPath, chunks: 0, ms: Date.now() - t1, ok: true });
      }
    }
  } catch (err: unknown) {
    parentPort!.postMessage({ type: "error", error: `[worker] queue error: ${String(err)}` });
  } finally {
    isIndexing = false;
    if (watcherQueue.size > 0 && !isPaused) {
      setTimeout(processQueue, 100);
    }
  }
}

parentPort.on("message", async (msg) => {
  try {
    if (msg.type === "config") {
      const { serverConfig, projectConfig, qdrant } = msg as {
        serverConfig: ServerConfig;
        projectConfig: ProjectConfig;
        qdrant: { url: string; api_key: string };
      };
      
      if (isInitializing) return;

      const { initQdrant } = await import("../qdrant.js");
      initQdrant(qdrant.url, qdrant.api_key);
      
      currentProjectConfig = projectConfig;
      applyServerConfig(serverConfig, projectConfig.project_id, projectConfig.agent_id);
      
      const wasPaused = isPaused;
      isPaused = projectConfig.indexer_state === "paused";
      
      if (!indexer) {
        isInitializing = true;
        const root = resolve(projectConfig.project_root || ".");
        const branch = getCurrentBranch(root);

        parentPort!.postMessage({ type: "info", message: `Initializing indexer for project ${projectConfig.project_id} on branch ${branch}` });

        indexer = new CodeIndexer({
          projectId: projectConfig.project_id,
          projectRoot: projectConfig.project_root,
          includePaths: projectConfig.include_paths,
          generateDescriptions: cfg.generateDescriptions,
          branch,
        });
        
        await indexer.ensureCollection();
        
        parentPort!.postMessage({ type: "info", message: `Starting initial scan for ${root}` });

        await indexer.indexAll(root, {
          suppressCountLog: true,
          onProgress: (done, total, chunks) => {
            parentPort!.postMessage({ type: "progress", done, total, chunks });
          }
        });
        
        startWatcher(root, indexer, {
          ignoreInitial: true,
          getState: () => isPaused ? "paused" : "running",
          enqueueEvent: (absPath) => {
            watcherQueue.add(absPath);
            if (!isPaused) processQueue();
          },
          onRecordIndex: (relPath, chunks, ms, ok) => {
            parentPort!.postMessage({ type: "recordIndex", relPath, chunks, ms, ok });
          },
        });
        
        isInitializing = false;
        parentPort!.postMessage({ type: "info", message: `Indexer ready for project ${projectConfig.project_id}` });
      }
      
      if (wasPaused && !isPaused) {
        processQueue();
      }
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err.stack : String(err);
    parentPort!.postMessage({ type: "error", error: `Worker crash: ${error}` });
    process.exit(1);
  }
});

process.on("unhandledRejection", (reason) => {
  parentPort?.postMessage({ type: "error", error: `unhandledRejection: ${String(reason)}` });
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  parentPort?.postMessage({ type: "error", error: `uncaughtException: ${err.stack ?? err.message}` });
  process.exit(1);
});
