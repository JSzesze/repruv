import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { verifyProxySecret } from "../src/proxy-auth";

const http = httpRouter();
http.route({
  path: "/internal/extract",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    if (!await verifyProxySecret(token, process.env.REPRUV_PROXY_SECRET)) {
      return new Response(null, { status: 401 });
    }
    let input: { url?: unknown; ttlSeconds?: unknown };
    try {
      const raw = await request.text();
      if (raw.length > 8192) return new Response(null, { status: 413 });
      input = JSON.parse(raw);
      if (!input || typeof input.url !== "string" || input.url.length > 4096 || typeof input.ttlSeconds !== "number" || !Number.isFinite(input.ttlSeconds)) {
        return new Response(null, { status: 400 });
      }
    } catch {
      return new Response(null, { status: 400 });
    }
    try {
      const result = await ctx.runAction(internal.extraction.extract, { url: input.url as string, ttlSeconds: input.ttlSeconds as number });
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Extraction failed.";
      return Response.json({ error: { code: "EXTRACTION_FAILED", message } }, {
        status: 502, headers: { "Cache-Control": "no-store" },
      });
    }
  }),
});
export default http;
