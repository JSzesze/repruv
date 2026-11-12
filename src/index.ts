import { recordUsage } from "./analytics";
import { readCachedResult, resultAgeSeconds } from "./cache";
import { relayBrowserRequest } from "./browser-relay";
import type { ExtractionResponse, StoredExtraction } from "./types";
import type { Env } from "./worker-types";
import { cacheKeyForUrl, normalizeUrl } from "./url";
import { readTextLimited } from "./bounded-body";
import { describeFailure, ExtractionFailure } from "./failures";
import { isStoredExtraction } from "./result-contract";
import { measured, timingRecorder } from "./timing";
import type { CoordinatedResult } from "./coordinator";
import { verifyProxySecret } from "./proxy-auth";
export { ExtractionCoordinator } from "./coordinator";
export { FallbackBudget } from "./fallback-budget";

const API_HEADERS = {
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

const SCANNER_PATHS = new Set([
  "/.claude.json",
  "/.claude/settings.json",
  "/_next/build-manifest.json",
  "/ngsw.json",
  "/public/admin.json",
  "/webpack-stats.json",
]);

const BROWSER_EVENTS = new Set([
  "browser_page_view",
  "conversion_submit",
  "copy_markdown",
  "download_markdown",
  "example_click",
  "input_engaged",
  "new_conversion",
  "share_link",
]);

const BROWSER_PAGES = new Set([
  "home",
  "other",
  "url-guide",
  "webpage-guide",
  "x-guide",
]);

function isKnownScannerPath(pathname: string) {
  const path = pathname.toLowerCase();
  return (
    SCANNER_PATHS.has(path) ||
    path === "/.env" ||
    path === "/.git" ||
    path === "/.hg" ||
    path === "/.svn" ||
    path.startsWith("/.env.") ||
    path.startsWith("/.git/") ||
    path.startsWith("/.hg/") ||
    path.startsWith("/.svn/") ||
    path.startsWith("/wp-") ||
    path.startsWith("/wordpress/") ||
    path.endsWith(".php")
  );
}

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(API_HEADERS)) headers.set(name, value);
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

function errorResponse(message: string, status = 400, code = "BAD_REQUEST") {
  return json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

function ttlFromEnv(env: Env) {
  const parsed = Number(env.CACHE_TTL_SECONDS || 604_800);
  return Number.isFinite(parsed)
    ? Math.min(30 * 24 * 60 * 60, Math.max(60 * 60, Math.floor(parsed)))
    : 604_800;
}

function withCacheMetadata(
  result: StoredExtraction,
  key: string,
  status: ExtractionResponse["cache"]["status"],
): ExtractionResponse {
  return {
    ...result,
    cache: { ageSeconds: resultAgeSeconds(result), key, status },
  };
}

function responseForResult(
  result: ExtractionResponse,
  format: "json" | "markdown" | "plain",
  stale = false,
  options: { interactiveUrl?: string } = {},
) {
  const headers = new Headers(API_HEADERS);
  const remaining = Math.max(0, Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1000));
  headers.set("Cache-Control", stale ? "no-store" : `public, max-age=${Math.min(300, remaining)}, s-maxage=${Math.min(86400, remaining)}`);
  headers.set("X-Cache", result.cache.status);
  headers.set("X-Extraction-Provider", result.provider);
  headers.set("X-Content-Status", result.contentStatus || "article");
  if (stale) headers.set("Warning", '110 - "Response is stale"');

  if (format === "markdown" || format === "plain") {
    // /md share links use text/plain so browsers show a readable page instead of downloading.
    headers.set(
      "Content-Type",
      format === "plain" ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8",
    );
    if (format === "markdown") {
      headers.set("Content-Disposition", `inline; filename="${safeFilename(result.title)}.md"`);
    }
    if (options.interactiveUrl) {
      headers.set(
        "Link",
        `<${options.interactiveUrl}>; rel="alternate"; type="text/html", </api/markdown?url=${encodeURIComponent(result.sourceUrl)}>; rel="alternate"; type="text/markdown"`,
      );
    }
    return new Response(result.markdown, { headers });
  }
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(result, null, 2), { headers });
}

function plainTextResponse(message: string, status = 400) {
  return new Response(`${message}\n`, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function safeFilename(title: string) {
  const filename = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return filename || "document";
}

async function inputUrl(request: Request) {
  const requestUrl = new URL(request.url);
  if (request.method === "GET") return requestUrl.searchParams.get("url") || "";
  if (request.method === "POST") {
    const contentType = request.headers.get("content-type") || "";
    const raw = (await readTextLimited(new Response(request.body, { headers: request.headers }), 8192)).body;
    if (contentType.includes("application/json")) {
      let body: unknown;
      try { body = JSON.parse(raw); }
      catch { throw new ExtractionFailure("INVALID_REQUEST", "Request body must be valid JSON.", 400); }
      if (!body || typeof body !== "object" || !("url" in body) || typeof body.url !== "string") {
        throw new ExtractionFailure("INVALID_REQUEST", "A string url field is required.", 400);
      }
      return body.url;
    }
    const form = await new Request(request.url, { method: "POST", headers: request.headers, body: raw }).formData();
    const value = form.get("url");
    return typeof value === "string" ? value : "";
  }
  return "";
}

function edgeCache() {
  return (caches as CacheStorage & { default: Cache }).default;
}

function edgeCacheRequest(request: Request, key: string) {
  const url = new URL(request.url);
  url.pathname = `/__cached/${key.replace(/[^a-zA-Z0-9/.-]/g, "")}`;
  url.search = "";
  return new Request(url, { method: "GET" });
}

async function readEdge(request: Request, key: string) {
  try {
    const response = await edgeCache().match(edgeCacheRequest(request, key));
    if (!response) return null;
    const result: unknown = await response.json();
    return isStoredExtraction(result) && Date.parse(result.expiresAt) > Date.now() ? result : null;
  } catch {
    return null;
  }
}

async function writeEdge(request: Request, key: string, result: StoredExtraction) {
  const response = new Response(JSON.stringify(result), {
    headers: {
      "Cache-Control": "public, s-maxage=86400",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
  await edgeCache().put(edgeCacheRequest(request, key), response);
}

async function enforceMissRateLimit(request: Request, env: Env) {
  const serviceToken = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  // Savit already enforces authenticated per-user import quotas. Its shared
  // server IP must not consume the anonymous visitor's ten-miss allowance.
  if (await verifyProxySecret(serviceToken, env.REPRUV_SERVICE_TOKEN)) return true;
  if (!env.MISS_LIMITER) return true;
  const actor = request.headers.get("CF-Connecting-IP") || "unknown";
  const result = await env.MISS_LIMITER.limit({ key: `miss:${actor}` });
  return result.success;
}

async function handleExtraction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  format: "json" | "markdown" | "plain",
) {
  const startedAt = Date.now();
  const timing = timingRecorder();
  const asPlain = format === "plain";
  const fail = (message: string, status = 400, code = "BAD_REQUEST") =>
    asPlain ? plainTextResponse(message, status) : errorResponse(message, status, code);

  let rawUrl: string;
  try { rawUrl = await inputUrl(request); }
  catch (error) {
    const failure = describeFailure(error);
    return fail(failure.message, failure.status, failure.code);
  }
  if (rawUrl.length > 4096) return fail("URL exceeds the 4096 character limit.", 413, "TOO_LARGE");
  if (!rawUrl) {
    ctx.waitUntil(
      recordUsage(env, {
        durationMs: Date.now() - startedAt,
        eventName: "conversion",
        outcome: "missing_url",
        statusCode: 400,
      }),
    );
    return fail(
      asPlain
        ? "A url parameter is required.\n\nUsage: /md?url=https://example.com"
        : "A url parameter is required.",
    );
  }

  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeUrl(rawUrl);
  } catch (error) {
    ctx.waitUntil(
      recordUsage(env, {
        durationMs: Date.now() - startedAt,
        eventName: "conversion",
        outcome: "invalid_url",
        statusCode: 400,
      }),
    );
    return fail(error instanceof Error ? error.message : "Invalid URL.", 400, "INVALID_URL");
  }

  const key = await cacheKeyForUrl(normalizedUrl);
  const requestUrl = new URL(request.url);
  const interactiveUrl = `${requestUrl.origin}/?url=${encodeURIComponent(normalizedUrl)}`;
  const resultOptions = asPlain ? { interactiveUrl } : {};

  const edgeResult = await measured(timing.observe, "edge_read", () => readEdge(request, key));
  if (edgeResult) {
    ctx.waitUntil(
      recordUsage(env, {
        cacheStatus: "HIT",
        durationMs: Date.now() - startedAt,
        eventName: "conversion",
        markdownBytes: edgeResult.stats.markdownBytes,
        outcome: "success",
        provider: edgeResult.provider,
        source: "edge",
        statusCode: 200,
        words: edgeResult.stats.words,
      }),
    );
    return responseForResult(withCacheMetadata(edgeResult, key, "HIT"), format, false, resultOptions);
  }

  const cached = await measured(timing.observe, "edge_r2", () => readCachedResult(env, key));
  if (cached && !cached.stale) {
    ctx.waitUntil(
      Promise.all([
        writeEdge(request, key, cached.result),
        recordUsage(env, {
          cacheStatus: "HIT",
          durationMs: Date.now() - startedAt,
          eventName: "conversion",
          markdownBytes: cached.result.stats.markdownBytes,
          outcome: "success",
          provider: cached.result.provider,
          source: "r2",
          statusCode: 200,
          words: cached.result.stats.words,
        }),
      ]).then(() => undefined),
    );
    return responseForResult(withCacheMetadata(cached.result, key, "HIT"), format, false, resultOptions);
  }

  if (!(await enforceMissRateLimit(request, env))) {
    if (cached) {
      ctx.waitUntil(
        recordUsage(env, {
          cacheStatus: "STALE",
          durationMs: Date.now() - startedAt,
          eventName: "conversion",
          markdownBytes: cached.result.stats.markdownBytes,
          outcome: "success",
          provider: cached.result.provider,
          source: "r2",
          statusCode: 200,
          words: cached.result.stats.words,
        }),
      );
      return responseForResult(
        withCacheMetadata(cached.result, key, "STALE"),
        format,
        true,
        resultOptions,
      );
    }
    ctx.waitUntil(
      recordUsage(env, {
        durationMs: Date.now() - startedAt,
        eventName: "conversion",
        outcome: "rate_limited",
        statusCode: 429,
      }),
    );
    return fail("Too many uncached conversions. Try again in about a minute.", 429, "RATE_LIMITED");
  }

  let retryAfter = 0;
  try {
    const outcome = await measured<CoordinatedResult>(timing.observe, "coordinator_rpc", async () => await env.EXTRACTION_COORDINATOR.getByName(key).extract(normalizedUrl, ttlFromEnv(env)));
    if (!outcome.ok) {
      retryAfter = outcome.retryAfter;
      throw new ExtractionFailure(outcome.failure.code, outcome.failure.message, outcome.failure.status, outcome.failure.retryable);
    }
    const result = outcome.result;
    console.info(JSON.stringify({ event: "request_timing", phases: timing.phases, wallMs: Date.now() - startedAt, cache: outcome.cache }));
    ctx.waitUntil(
      Promise.all([
        writeEdge(request, key, result),
        recordUsage(env, {
          cacheStatus: outcome.cache,
          durationMs: Date.now() - startedAt,
          eventName: "conversion",
          markdownBytes: result.stats.markdownBytes,
          outcome: "success",
          provider: result.provider,
          source: "origin",
          statusCode: 200,
          words: result.stats.words,
        }),
      ]).then(() => undefined),
    );
    return responseForResult(withCacheMetadata(result, key, outcome.cache), format, false, resultOptions);
  } catch (error) {
    if (cached) {
      ctx.waitUntil(
        recordUsage(env, {
          cacheStatus: "STALE",
          durationMs: Date.now() - startedAt,
          eventName: "conversion",
          markdownBytes: cached.result.stats.markdownBytes,
          outcome: "success",
          provider: cached.result.provider,
          source: "r2",
          statusCode: 200,
          words: cached.result.stats.words,
        }),
      );
      return responseForResult(
        withCacheMetadata(cached.result, key, "STALE"),
        format,
        true,
        resultOptions,
      );
    }
    ctx.waitUntil(
      recordUsage(env, {
        durationMs: Date.now() - startedAt,
        eventName: "conversion",
        outcome: "extraction_failed",
        statusCode: 502,
      }),
    );
    const failure = describeFailure(error);
    const response = fail(failure.message, failure.status, failure.code);
    if (retryAfter) response.headers.set("Retry-After", String(retryAfter));
    return response;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "www.repruv.com") {
      url.hostname = "repruv.com";
      url.protocol = "https:";
      return Response.redirect(url.toString(), 308);
    }
    if (isKnownScannerPath(url.pathname)) {
      return new Response("Not found", {
        status: 404,
        headers: {
          "Cache-Control": "public, max-age=3600",
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: API_HEADERS });
    }
    if (url.pathname === "/api/event") {
      const origin = request.headers.get("Origin");
      const fetchSite = request.headers.get("Sec-Fetch-Site");
      const contentLength = Number(request.headers.get("Content-Length") || 0);
      if (
        request.method !== "POST" ||
        origin !== url.origin ||
        (fetchSite && fetchSite !== "same-origin")
      ) {
        return new Response(null, { status: 404 });
      }
      if (contentLength > 128) {
        return new Response(null, { status: 413 });
      }
      const rawBody = await request.text();
      if (rawBody.length > 128) {
        return new Response(null, { status: 413 });
      }
      const body = (() => {
        try {
          return JSON.parse(rawBody);
        } catch {
          return null;
        }
      })() as {
        event?: unknown;
        page?: unknown;
      } | null;
      if (
        typeof body?.event !== "string" ||
        !BROWSER_EVENTS.has(body.event) ||
        typeof body.page !== "string" ||
        !BROWSER_PAGES.has(body.page)
      ) {
        return new Response(null, { status: 400 });
      }
      ctx.waitUntil(
        recordUsage(env, {
          eventName: body.event as
            | "browser_page_view"
            | "conversion_submit"
            | "copy_markdown"
            | "download_markdown"
            | "example_click"
            | "input_engaged"
            | "new_conversion"
            | "share_link",
          outcome: body.event === "browser_page_view" ? "loaded" : "recorded",
          source: body.page,
          statusCode: 204,
        }),
      );
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (url.pathname === "/api/internal/browser") return relayBrowserRequest(request, env);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "url-to-markdown", version: 1 });
    }
    // Shareable plain-text Markdown page: /md?url=https://example.com
    if (url.pathname === "/md" || url.pathname === "/md/") {
      if (request.method !== "GET") {
        return plainTextResponse("Method not allowed. Use GET /md?url=…", 405);
      }
      return handleExtraction(request, env, ctx, "plain");
    }
    if (url.pathname === "/api/extract") {
      if (request.method !== "GET" && request.method !== "POST") {
        return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
      }
      return handleExtraction(request, env, ctx, "json");
    }
    if (url.pathname === "/api/markdown") {
      if (request.method !== "GET" && request.method !== "POST") {
        return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
      }
      return handleExtraction(request, env, ctx, "markdown");
    }
    if (url.pathname.startsWith("/api/")) {
      return errorResponse("API route not found.", 404, "NOT_FOUND");
    }
    return env.ASSETS.fetch(request);
  },
};
