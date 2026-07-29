#!/usr/bin/env node

import { resolve } from "node:path";
import { createServer } from "vite";

const source = resolve(import.meta.dirname, "../src/tau2-bridge.ts");
const vite = await createServer({
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true },
});

let bridge;
try {
  const module = await vite.ssrLoadModule(source);
  bridge = await module.runTau2BridgeCli();
} finally {
  await vite.close();
}

await new Promise((resolveShutdown) => {
  let closing = false;
  const shutdown = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await bridge.close();
    resolveShutdown();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
});
