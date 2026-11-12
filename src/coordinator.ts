import { DurableObject } from "cloudflare:workers";
import type { Env } from "./worker-types";
import type { StoredExtraction } from "./types";
import { readCachedResult, writeCachedResult } from "./cache";
import { cacheKeyForUrl, normalizeUrl } from "./url";
import { extractUrl } from "./extract";
import { extractViaConvex } from "./convex-extraction";
import { describeFailure, type FailureResult } from "./failures";
import { budgetedBrowser, withFallbackAllowance } from "./fallback-policy";
import { extractFirecrawl } from "./firecrawl";
import { normalizeExtraction } from "./result-contract";
import { measured, timingRecorder } from "./timing";

export type CoordinatedResult = { ok: true; result: StoredExtraction; cache: "MISS" | "HIT" }
  | { ok: false; failure: FailureResult; retryAfter: number };

type PendingWrite = {
  revision: string;
  cache_key: string;
  retry_at: number;
  attempts: number;
}

export class ExtractionCoordinator extends DurableObject<Env> {
  private inFlight: Promise<CoordinatedResult> | undefined;
  private flushing: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pending_cache (id INTEGER PRIMARY KEY CHECK(id = 1), revision TEXT NOT NULL, cache_key TEXT NOT NULL, retry_at INTEGER NOT NULL, attempts INTEGER NOT NULL)");
    // Chunk JSON so even escaped Markdown cannot exceed SQLite's row-size limit.
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pending_payload (part INTEGER PRIMARY KEY, data TEXT NOT NULL)");
  }

  async extract(rawUrl: string, ttl: number): Promise<CoordinatedResult> {
    // Promise assignment precedes any await: every caller for this URL joins the
    // same operation. Pending results and failures survive eviction in SQLite.
    if (!this.inFlight) this.inFlight = this.run(normalizeUrl(rawUrl), ttl).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async run(url: string, ttl: number): Promise<CoordinatedResult> {
    const timing = timingRecorder();
    const started = Date.now();
    const key = await cacheKeyForUrl(url);
    const pending = this.pending();
    if (pending) {
      const result = this.pendingResult();
      this.startFlush();
      if (Date.parse(result.expiresAt) > Date.now()) return { ok: true, result, cache: "HIT" };
    }
    const cached = await measured(timing.observe, "coordinator_r2", () => readCachedResult(this.env, key));
    if (cached && !cached.stale) return { ok: true, result: cached.result, cache: "HIT" };
    const previous = await measured(timing.observe, "failure_lookup", () => this.ctx.storage.get<{ until: number; failure: FailureResult }>("failure"));
    if (previous && previous.until > Date.now()) return { ok: false, failure: previous.failure, retryAfter: Math.ceil((previous.until - Date.now()) / 1000) };
    try {
      let result: StoredExtraction;
      try {
        const run = () => this.env.CONVEX_SITE_URL
          ? extractViaConvex(this.env.CONVEX_SITE_URL, this.env.REPRUV_PROXY_SECRET, url, ttl)
          : extractUrl({ ...this.env, BROWSER: budgetedBrowser(this.env), onTiming: timing.observe }, url, ttl);
        try { result = normalizeExtraction(await run()); }
        catch (error) {
          if (!describeFailure(error).retryable) throw error;
          await new Promise(resolve => setTimeout(resolve, 250));
          result = normalizeExtraction(await run());
        }
      } catch (error) {
        const failure = describeFailure(error);
        if (!this.env.FIRECRAWL_API_KEY || failure.code === "INVALID_URL" || failure.code === "BUDGET_EXHAUSTED") throw error;
        result = normalizeExtraction(await withFallbackAllowance(this.env, "firecrawl", () => extractFirecrawl(url, this.env.FIRECRAWL_API_KEY!, ttl)));
      }
      // Commit a durable handoff before replying. R2 latency is outside the
      // response path; retries and later callers can recover the exact result.
      this.savePending(key, result);
      await measured(timing.observe, "failure_cleanup", () => this.ctx.storage.delete("failure"));
      await this.scheduleNextAlarm();
      this.startFlush();
      console.info(JSON.stringify({ event: "extraction_timing", phases: timing.phases, wallMs: Date.now() - started, provider: result.provider }));
      return { ok: true, result, cache: "MISS" };
    } catch (error) {
      const failure = describeFailure(error);
      const retryAfter = failure.retryable ? 10 : failure.code === "INVALID_URL" ? 5 : 60;
      await this.ctx.storage.put("failure", { until: Date.now() + retryAfter * 1000, failure });
      await this.scheduleNextAlarm();
      console.warn(JSON.stringify({ event: "extraction_failed", code: failure.code, retryable: failure.retryable }));
      return { ok: false, failure, retryAfter };
    }
  }

  private pending(): PendingWrite | undefined {
    return this.ctx.storage.sql.exec<PendingWrite>("SELECT revision, cache_key, retry_at, attempts FROM pending_cache WHERE id = 1").toArray()[0];
  }

  private pendingResult(): StoredExtraction {
    const payload = this.ctx.storage.sql.exec<{ data: string }>("SELECT data FROM pending_payload ORDER BY part").toArray().map(row => row.data).join("");
    return JSON.parse(payload) as StoredExtraction;
  }

  private savePending(key: string, result: StoredExtraction): void {
    const payload = JSON.stringify(result);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM pending_payload");
      let part = 0;
      for (let offset = 0; offset < payload.length;) {
        let end = Math.min(offset + 65536, payload.length);
        const last = payload.charCodeAt(end - 1);
        if (end < payload.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
        this.ctx.storage.sql.exec("INSERT INTO pending_payload(part, data) VALUES (?, ?)", part++, payload.slice(offset, end));
        offset = end;
      }
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO pending_cache(id, revision, cache_key, retry_at, attempts) VALUES (1, ?, ?, ?, 0)", crypto.randomUUID(), key, Date.now());
    });
  }

  private startFlush(): void {
    if (this.flushing) return;
    this.flushing = this.flushPending().finally(() => { this.flushing = undefined; });
    this.ctx.waitUntil(this.flushing.catch(() => { console.warn(JSON.stringify({ event: "cache_handoff_retry_needed" })); }));
  }

  private async flushPending(): Promise<void> {
    // Serialize transfers so an older result cannot overwrite a newer refresh.
    let pending = this.pending();
    while (pending && pending.retry_at <= Date.now()) {
      const result = this.pendingResult();
      try {
        await writeCachedResult(this.env, pending.cache_key, result);
        const completedRevision = pending.revision;
        this.ctx.storage.transactionSync(() => {
          if (this.pending()?.revision !== completedRevision) return;
          this.ctx.storage.sql.exec("DELETE FROM pending_cache");
          this.ctx.storage.sql.exec("DELETE FROM pending_payload");
        });
      } catch {
        const attempts = pending.attempts + 1;
        const retryAt = Date.now() + Math.min(3_600_000, 1000 * 2 ** Math.min(attempts, 12));
        this.ctx.storage.sql.exec("UPDATE pending_cache SET retry_at = ?, attempts = ? WHERE revision = ?", retryAt, attempts, pending.revision);
        console.warn(JSON.stringify({ event: "cache_write_retry", attempts }));
        break;
      }
      pending = this.pending();
    }
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    const failure = await this.ctx.storage.get<{ until: number }>("failure");
    const pending = this.pending();
    const deadlines = [failure?.until, pending?.retry_at].filter((value): value is number => value !== undefined);
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(...deadlines)));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const previous = await this.ctx.storage.get<{ until: number }>("failure");
    if (previous && previous.until <= Date.now()) await this.ctx.storage.delete("failure");
    if (this.flushing) await this.flushing;
    else await this.flushPending();
  }
}
