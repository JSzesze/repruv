"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { extractUrl } from "../src/extract";
import { assertPublicUrl } from "../src/url";
import { extractionResult } from "./validators";
import type { ExtractionEnv } from "../src/types";

export const extract = internalAction({
  args: { url: v.string(), ttlSeconds: v.number() },
  returns: extractionResult,
  handler: async (_ctx, args) => {
    const url = await assertPublicUrl(args.url);
    const ttlSeconds = Math.min(30 * 86400, Math.max(3600, Math.floor(args.ttlSeconds)));
    if (!Number.isFinite(ttlSeconds)) throw new Error("Invalid cache lifetime.");
    const edgeUrl = process.env.REPRUV_EDGE_URL;
    const secret = process.env.REPRUV_PROXY_SECRET;
    const env: ExtractionEnv = {
      ENABLE_BROWSER_FALLBACK: edgeUrl && secret ? "true" : "false",
      BROWSER: edgeUrl && secret ? {
        quickAction: async (action, input) => fetch(new URL("/api/internal/browser", edgeUrl), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
          body: JSON.stringify({ action, url: input.url }),
          signal: AbortSignal.timeout(60_000),
        }),
      } : undefined,
    };
    const result = await extractUrl(env, url, ttlSeconds);
    // Convex values cannot contain undefined properties (browser Markdown may
    // not have a source-byte measurement).
    if (result.stats.sourceBytes === undefined) delete result.stats.sourceBytes;
    return result;
  },
});
