#!/usr/bin/env node
const args = process.argv.slice(2).filter((a) => a !== "--");
const cmd = args[0];

if (cmd === "serve" || cmd === "server") {
  const { startHttpServer } = await import("./http-server.js");
  await startHttpServer();
} else if (cmd === "init") {
  const { init } = await import("./init.js");
  init();
} else if (cmd === "migrate") {
  const { runMigrate } = await import("./migrate.js");
  await runMigrate();
} else if (cmd === "normalize-logs") {
  await import("./normalize-logs.js");
} else if (cmd === "hook-recall") {
  const { runHookRecall } = await import("./hook-recall.js");
  await runHookRecall();
} else if (cmd === "hook-remember") {
  const { runHookRemember } = await import("./hook-remember.js");
  await runHookRemember();
} else if (cmd === "hook-session-start") {
  const { runHookSessionStart } = await import("./hook-session-start.js");
  await runHookSessionStart();
} else if (cmd === "hook-session-end") {
  const { runHookSessionEnd } = await import("./hook-session-end.js");
  await runHookSessionEnd();
} else {
  await import("./indexer/cli.js");
}
