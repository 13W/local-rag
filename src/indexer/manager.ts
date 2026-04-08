import { Worker } from "node:worker_threads";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectConfig, ServerConfig } from "../server-config.js";
import { loadServerConfig } from "../server-config.js";
import { qd } from "../qdrant.js";
import { recordIndex, startReindex, tickReindex, endReindex } from "../plugins/dashboard.js";

const _dir = dirname(fileURLToPath(import.meta.url));
const activeWatchers = new Map<string, Worker>();

export class IndexerManager {
  static async syncProject(project: ProjectConfig, localConfig: import("../local-config.js").LocalConfig): Promise<void> {
    if (project.indexer_state === "stopped") {
      this.stopProject(project.project_id);
      return;
    }

    let worker = activeWatchers.get(project.project_id);
    const serverConfig = await loadServerConfig(qd);

    if (!worker) {
      // Use the built JS file for the worker
      const workerPath = resolve(_dir, "worker.js");
      worker = new Worker(workerPath);
      
      worker.on("message", (msg) => {
        if (msg.type === "recordIndex") {
          recordIndex(project.project_id, msg.relPath, msg.chunks, msg.ms, msg.ok);
        } else if (msg.type === "progress") {
          if (msg.done === 1 && msg.total > 1) startReindex(msg.total);
          tickReindex(msg.done, msg.chunks);
          if (msg.done === msg.total) endReindex();
        } else if (msg.type === "info") {
          process.stderr.write(`[indexer-manager] ${msg.message}\n`);
        } else if (msg.type === "error") {
          process.stderr.write(`[indexer-manager] Project ${project.project_id} error: ${msg.error}\n`);
        }
      });

      worker.on("error", (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[indexer-manager] Worker error for project ${project.project_id}: ${msg}\n`);
      });

      worker.on("exit", (code) => {
        if (code !== 0) {
          process.stderr.write(`[indexer-manager] Worker for project ${project.project_id} stopped with exit code ${code}\n`);
        }
        activeWatchers.delete(project.project_id);
      });

      activeWatchers.set(project.project_id, worker);
    }

    worker.postMessage({
      type: "config",
      serverConfig,
      projectConfig: project,
      qdrant: localConfig.qdrant
    });
  }

  static stopProject(projectId: string): void {
    const worker = activeWatchers.get(projectId);
    if (worker) {
      worker.terminate().catch(err => {
        process.stderr.write(`[indexer-manager] Failed to terminate worker for ${projectId}: ${err}\n`);
      });
      activeWatchers.delete(projectId);
    }
  }

  static stopAll(): void {
    for (const [projectId, worker] of activeWatchers) {
      worker.terminate().catch(() => {});
      activeWatchers.delete(projectId);
    }
  }
}
