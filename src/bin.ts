#!/usr/bin/env node
const args = process.argv.slice(2).filter((a) => a !== "--");
const cmd = args[0];

if (cmd === "serve" || cmd === "server") {
  await import("./server.js");
} else if (cmd === "init") {
  const { init } = await import("./init.js");
  init();
} else if (cmd === "migrate") {
  const { runMigrate } = await import("./migrate.js");
  await runMigrate();
} else {
  await import("./indexer/cli.js");
}
