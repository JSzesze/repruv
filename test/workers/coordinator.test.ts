/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext, evictDurableObject, abortAllDurableObjects, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { readHtmlLimited } from "../../src/bounded-body";
import { cacheKeyForUrl } from "../../src/url";
import type { StoredExtraction } from "../../src/types";
import { htmlToReadableMarkdown } from "../../src/extract";

afterEach(() => vi.restoreAllMocks());
const html = '<!doctype html><html><head><title>A runtime article</title></head><body><article><h1>A runtime article</h1><p>A useful article with enough context for extraction, including a stable reading body for the fixture.</p></article></body></html>';

describe("Cloudflare extraction coordination", () => {
  it("rechecks R2 when a result arrives between the outer miss and coordination", async () => {
    const url = `https://93.184.216.34/${crypto.randomUUID()}`;
    const key = await cacheKeyForUrl(url);
    const saved: StoredExtraction = { author: null, title: "Concurrent article", markdown: "# Concurrent article\n\nAccepted public body.\n", provider: "direct-html", version: 1, sourceUrl: url, finalUrl: url, fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), stats: { words: 6, markdownBytes: 46 } };
    const originalGet = env.RESULTS.get.bind(env.RESULTS);
    const get = vi.spyOn(env.RESULTS, "get").mockImplementationOnce(async () => {
      await env.RESULTS.put(key, JSON.stringify(saved));
      return null;
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Origin must not be fetched"); });
    const ctx = createExecutionContext();
    const request = new Request(`https://repruv.test/api/extract?url=${encodeURIComponent(url)}`);
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ title: "Concurrent article", cache: { status: "HIT" } });
    expect(fetch).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
    get.mockImplementation(originalGet);
    const repeatCtx = createExecutionContext();
    const repeated = await worker.fetch(request, env, repeatCtx);
    await waitOnExecutionContext(repeatCtx);
    expect(repeated.status).toBe(200);
    expect(get).toHaveBeenCalledTimes(2); // The warmed edge cache avoids another R2 read.
  });
  it("extracts HTML in the Workers runtime", async () => {
    expect(await htmlToReadableMarkdown(html, "https://example.com/article")).toMatchObject({ title: "A runtime article" });
  });
  it("keeps editorial callouts and collapsed public answers through streaming cleanup", async () => {
    const source = html.replace("</article>", '<div class="rich-content-callout"><aside><h3>A useful summary</h3><p>The summary explains the article and belongs to its reading content.</p></aside></div><div><button id="question" aria-controls="answer" aria-expanded="false">Why does this matter?</button><div id="answer" role="region" aria-labelledby="question" hidden><p>The public answer provides additional context that should remain available in the extracted article.</p></div></div><div hidden>Unrelated hidden promotion</div></article>');
    const cleaned = await readHtmlLimited(new Response(source));
    const result = await htmlToReadableMarkdown(cleaned.body, "https://example.com/article");
    expect(result.markdown).toContain("A useful summary");
    expect(result.markdown).toContain("Why does this matter?");
    expect(result.markdown).toContain("The public answer provides additional context");
    expect(result.markdown).not.toContain("Unrelated hidden promotion");
  });
  it("joins simultaneous misses and retains the accepted result for later callers", async () => {
    const url = `https://93.184.216.34/${crypto.randomUUID()}`;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await gate;
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    });
    const stub = env.EXTRACTION_COORDINATOR.getByName(await cacheKeyForUrl(url));
    const first = stub.extract(url, 3600);
    const second = stub.extract(url, 3600);
    release();
    const results = await Promise.all([first, second]);
    expect(results[0], JSON.stringify(results[0])).toMatchObject({ ok: true });
    expect(results.every(result => result.ok)).toBe(true);
    if (results[0].ok && results[1].ok) expect(results[0].result).toEqual(results[1].result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await stub.extract(url, 3600)).toMatchObject({ ok: true, cache: "HIT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns before a slow R2 write completes and serves the same pending result", async () => {
    const url = `https://93.184.216.34/${crypto.randomUUID()}`;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalPut = env.RESULTS.put.bind(env.RESULTS);
    const put = vi.spyOn(env.RESULTS, "put").mockImplementation(async (...args) => {
      await gate;
      return originalPut(...args);
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(html, { headers: { "Content-Type": "text/html" } }));
    const stub = env.EXTRACTION_COORDINATOR.getByName(await cacheKeyForUrl(url));
    try {
      const first = await stub.extract(url, 3600);
      expect(first).toMatchObject({ ok: true, cache: "MISS" });
      const repeat = await stub.extract(url, 3600);
      expect(repeat).toMatchObject({ ok: true, cache: "HIT" });
      if (first.ok && repeat.ok) expect(repeat.result).toEqual(first.result);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledTimes(1);
      expect(await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT revision FROM pending_cache").toArray().length)).toBe(1);
    } finally { release(); }
    await runDurableObjectAlarm(stub);
    expect(await env.RESULTS.get(await cacheKeyForUrl(url))).not.toBeNull();
  });

  it("recovers failed background writes after restart without extracting again", async () => {
    const url = `https://93.184.216.34/${crypto.randomUUID()}`;
    const put = vi.spyOn(env.RESULTS, "put").mockRejectedValue(new Error("R2 unavailable"));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(html, { headers: { "Content-Type": "text/html" } }));
    let stub = env.EXTRACTION_COORDINATOR.getByName(await cacheKeyForUrl(url));
    const first = await stub.extract(url, 3600);
    expect(first).toMatchObject({ ok: true });
    await vi.waitFor(async () => expect(await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ attempts: number }>("SELECT attempts FROM pending_cache").one().attempts)).toBe(1));
    await abortAllDurableObjects();
    stub = env.EXTRACTION_COORDINATOR.getByName(await cacheKeyForUrl(url));
    const recovered = await stub.extract(url, 3600);
    if (first.ok && recovered.ok) expect(recovered.result).toEqual(first.result);
    else throw new Error("Expected an accepted result before and after restart");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    put.mockRestore();
    await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec("UPDATE pending_cache SET retry_at = 0"); });
    await runDurableObjectAlarm(stub);
    const saved = await env.RESULTS.get(await cacheKeyForUrl(url));
    expect(await saved?.json()).toEqual(first.result);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT revision FROM pending_cache").toArray().length)).toBe(0);
  });

  it("round-trips large Unicode results through the chunked durable handoff", async () => {
    const url = `https://93.184.216.34/${crypto.randomUUID()}`;
    vi.spyOn(env.RESULTS, "put").mockRejectedValue(new Error("R2 unavailable"));
    const markdown = `# Unicode article\n\n${"An example 😀 explains an idea.\n".repeat(4000)}`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(markdown, { headers: { "Content-Type": "text/markdown" } }));
    let stub = env.EXTRACTION_COORDINATOR.getByName(await cacheKeyForUrl(url));
    const first = await stub.extract(url, 3600);
    expect(first).toMatchObject({ ok: true, result: { markdown } });
    await abortAllDurableObjects();
    stub = env.EXTRACTION_COORDINATOR.getByName(await cacheKeyForUrl(url));
    expect(await stub.extract(url, 3600)).toMatchObject({ ok: true, result: { markdown } });
  });

  it("caches blocked failures without retrying or repeatedly fetching the same URL", async () => {
    const url = `https://93.184.216.34/${crypto.randomUUID()}`;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("blocked", { status: 403 }));
    const stub = env.EXTRACTION_COORDINATOR.getByName(await cacheKeyForUrl(url));
    const result = await stub.extract(url, 3600);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, failure: { code: "BLOCKED" } });
    await abortAllDurableObjects();
    const restored = env.EXTRACTION_COORDINATOR.getByName(await cacheKeyForUrl(url));
    expect(await restored.extract(url, 3600)).toMatchObject({ ok: false, failure: { code: "BLOCKED" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient HTTP failure once and accepts the recovered article", async () => {
    const url = `https://93.184.216.34/${crypto.randomUUID()}`;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => new Response("temporary", { status: 503 }))
      .mockImplementationOnce(async () => new Response(html, { headers: { "Content-Type": "text/html" } }));
    const result = await env.EXTRACTION_COORDINATOR.getByName(await cacheKeyForUrl(url)).extract(url, 3600);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { title: "A runtime article", contentStatus: "article" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("removes large inline scripts before allocating the article DOM", async () => {
    const source = html.replace("</head>", `<script>${"x".repeat(1024 * 1024)}</script></head>`);
    const cleaned = await readHtmlLimited(new Response(source));
    expect(cleaned.bytes).toBeGreaterThan(1024 * 1024);
    expect(cleaned.body.length).toBeLessThan(1024);
    expect(cleaned.body).not.toContain("<script");
  });

  it("enforces daily, monthly and concurrent fallback limits in persistent SQLite", async () => {
    const stub = env.FALLBACK_BUDGET.getByName(crypto.randomUUID());
    const lease = await stub.reserve(2, 2, 1);
    expect(lease).toBeTypeOf("string");
    expect(await stub.reserve(2, 2, 1)).toBeNull();
    await stub.release(lease!);
    const next = await stub.reserve(2, 2, 1);
    expect(next).toBeTypeOf("string");
    await stub.release(next!);
    await evictDurableObject(stub);
    expect(await stub.reserve(2, 2, 1)).toBeNull();
  });

  it("returns stable request errors and keeps an accepted stale article on failure", async () => {
    const bad = await worker.fetch(new Request("https://repruv.test/api/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }), env, createExecutionContext());
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    const url = `https://93.184.216.34/${crypto.randomUUID()}`;
    const stale: StoredExtraction = { author: null, title: "Saved article", markdown: "# Saved article\n\nPrevious accepted body.\n", provider: "direct-html", version: 1, sourceUrl: url, finalUrl: url, fetchedAt: new Date(Date.now() - 7200000).toISOString(), expiresAt: new Date(Date.now() - 3600000).toISOString(), stats: { words: 6, markdownBytes: 50 } };
    await env.RESULTS.put(await cacheKeyForUrl(url), JSON.stringify(stale));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("blocked", { status: 403 }));
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`https://repruv.test/api/extract?url=${encodeURIComponent(url)}`), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Cache")).toBe("STALE");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ title: "Saved article" });
  });

  it("authenticates Savit requests while retaining anonymous miss limits", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const serviceEnv = { ...env, MISS_LIMITER: { limit }, REPRUV_SERVICE_TOKEN: "test-savit-service-secret" };
    const url = `https://93.184.216.34/${crypto.randomUUID()}`;
    const endpoint = `https://repruv.test/api/extract?url=${encodeURIComponent(url)}`;
    const denied = await worker.fetch(new Request(endpoint, { headers: { Authorization: "Bearer incorrect" } }), serviceEnv, createExecutionContext());
    expect(denied.status).toBe(429);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(html, { headers: { "Content-Type": "text/html" } }));
    const ctx = createExecutionContext();
    const accepted = await worker.fetch(new Request(endpoint, { headers: { Authorization: "Bearer test-savit-service-secret" } }), serviceEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(accepted.status).toBe(200);
    expect(limit).toHaveBeenCalledTimes(1);
  });
});
