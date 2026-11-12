import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // Defuddle uses require("turndown"). Keep Vite's worker resolver from handing
  // that CommonJS call Turndown's unbundled ES-module entry point.
  resolve: { alias: [{ find: /^turndown$/, replacement: path.resolve("node_modules/turndown/lib/turndown.cjs.js") }] },
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/workers/wrangler.jsonc" }, remoteBindings: false })],
  test: { include: ["test/workers/*.test.ts"], fileParallelism: false },
});
