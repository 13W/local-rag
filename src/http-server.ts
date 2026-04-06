import Fastify           from "fastify";
import { dirname }       from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap }     from "./bootstrap.js";
import { ensureConfigCollections, loadServerConfig } from "./server-config.js";
import { applyServerConfig, cfg } from "./config.js";
import { ensureCollections, qd }  from "./qdrant.js";
import { updateLocalConfigPort }  from "./local-config.js";
import { mcpPlugin }              from "./plugins/mcp.js";
import { hooksPlugin }            from "./plugins/hooks.js";
import { dashboardPlugin, broadcastShutdown, broadcastError } from "./plugins/dashboard.js";

const _dir = dirname(fileURLToPath(import.meta.url));

export async function startHttpServer(): Promise<void> {
  // 1. Connect to Qdrant (interactive if needed)
  await bootstrap();

  // 2. Ensure all collections exist
  await ensureCollections();
  await ensureConfigCollections(qd);

  // 3. Load server config from Qdrant
  const serverCfg = await loadServerConfig(qd);
  applyServerConfig(serverCfg);

  // 4. Build Fastify
  const fastify = Fastify({ logger: false });

  // Register plugins
  await fastify.register(mcpPlugin);
  await fastify.register(hooksPlugin);
  await fastify.register(dashboardPlugin);

  // 5. Start server on localhost only
  const port = cfg.port;
  await fastify.listen({ port, host: "127.0.0.1" });

  const addr       = fastify.server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  process.stderr.write(`[server] http://127.0.0.1:${actualPort}\n`);
  process.stderr.write(`[server] MCP: http://127.0.0.1:${actualPort}/mcp?project=<id>&agent=<id>\n`);

  // 6. Write actual port to local config (for hook subprocesses)
  await updateLocalConfigPort(actualPort);

  // 7. Graceful shutdown
  process.on("SIGINT",  () => { broadcastShutdown(); process.exit(0); });
  process.on("SIGTERM", () => { broadcastShutdown(); process.exit(0); });
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[server] uncaughtException: ${err.stack ?? err.message}\n`);
    broadcastError(err);
    setTimeout(() => process.exit(1), 250);
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    process.stderr.write(`[server] unhandledRejection: ${err.stack ?? err.message}\n`);
    broadcastError(err);
    setTimeout(() => process.exit(1), 250);
  });
}
