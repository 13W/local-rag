#!/usr/bin/env node
const args = process.argv.slice(2).filter((a) => a !== "--");
const cmd = args[0];

if (cmd === "serve" || cmd === "server") {
  await import("./server.js");
} else {
  await import("./indexer/cli.js");
}
