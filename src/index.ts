import { recordUsage } from "./analytics";
import { readCachedResult, resultAgeSeconds, writeCachedResult } from "./cache";
import { extractUrl } from "./extract";
import type { Env, ExtractionResponse, StoredExtraction } from "./types";
import { cacheKeyForUrl, normalizeUrl } from "./url";

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
  return json({ error: { code, message } }, { status });
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
  format: "json" | "markdown",
  stale = false,
) {
  const headers = new Headers(API_HEADERS);
  headers.set("Cache-Control", "public, max-age=300, s-maxage=86400");
  headers.set("X-Cache", result.cache.status);
  headers.set("X-Extraction-Provider", result.provider);
  if (stale) headers.set("Warning", '110 - "Response is stale"');

  if (format === "markdown") {
    headers.set("Content-Type", "text/markdown; charset=utf-8");
    headers.set("Content-Disposition", `inline; filename="${safeFilename(result.title)}.md"`);
    return new Response(result.markdown, { headers });
  }
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(result, null, 2), { headers });
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
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { url?: unknown };
      return typeof body.url === "string" ? body.url : "";
    }
    const form = await request.formData();
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
    const result = (await response.json()) as StoredExtraction;
    return Date.parse(result.expiresAt) > Date.now() ? result : null;
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
  if (!env.MISS_LIMITER) return true;
  const actor = request.headers.get("CF-Connecting-IP") || "unknown";
  const result = await env.MISS_LIMITER.limit({ key: `miss:${actor}` });
  return result.success;
}

async function handleExtraction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  format: "json" | "markdown",
) {
  const startedAt = Date.now();
  const rawUrl = await inputUrl(request);
  if (!rawUrl) {
    ctx.waitUntil(
      recordUsage(env, {
        durationMs: Date.now() - startedAt,
        eventName: "conversion",
        outcome: "missing_url",
        statusCode: 400,
      }),
    );
    return errorResponse("A url parameter is required.");
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
    return errorResponse(error instanceof Error ? error.message : "Invalid URL.");
  }

  const key = await cacheKeyForUrl(normalizedUrl);
  const edgeResult = await readEdge(request, key);
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
    return responseForResult(withCacheMetadata(edgeResult, key, "HIT"), format);
  }

  const cached = await readCachedResult(env, key);
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
    return responseForResult(withCacheMetadata(cached.result, key, "HIT"), format);
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
      return responseForResult(withCacheMetadata(cached.result, key, "STALE"), format, true);
    }
    ctx.waitUntil(
      recordUsage(env, {
        durationMs: Date.now() - startedAt,
        eventName: "conversion",
        outcome: "rate_limited",
        statusCode: 429,
      }),
    );
    return errorResponse(
      "Too many uncached conversions. Try again in about a minute.",
      429,
      "RATE_LIMITED",
    );
  }

  try {
    const result = await extractUrl(env, normalizedUrl, ttlFromEnv(env));
    ctx.waitUntil(
      Promise.all([
        writeCachedResult(env, key, result),
        writeEdge(request, key, result),
        recordUsage(env, {
          cacheStatus: "MISS",
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
    return responseForResult(withCacheMetadata(result, key, "MISS"), format);
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
      return responseForResult(withCacheMetadata(cached.result, key, "STALE"), format, true);
    }
    ctx.waitUntil(
      recordUsage(env, {
        durationMs: Date.now() - startedAt,
        eventName: "conversion",
        outcome: "extraction_failed",
        statusCode: 502,
      }),
    );
    return errorResponse(
      error instanceof Error ? error.message : "Extraction failed.",
      502,
      "EXTRACTION_FAILED",
    );
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
            | "input_engaged",
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
    if (url.pathname === "/health") {
      return json({ ok: true, service: "url-to-markdown", version: 1 });
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
