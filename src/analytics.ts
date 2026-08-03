import type { Env } from "./types";

export interface UsageEvent {
  cacheStatus?: "" | "HIT" | "MISS" | "STALE";
  durationMs?: number;
  eventName:
    | "browser_page_view"
    | "conversion"
    | "conversion_submit"
    | "copy_markdown"
    | "download_markdown"
    | "example_click"
    | "input_engaged"
    | "new_conversion";
  markdownBytes?: number;
  outcome?: string;
  provider?: string;
  source?: string;
  statusCode?: number;
  words?: number;
}

function finiteInteger(value: number | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value || 0)) : 0;
}

export async function recordUsage(env: Env, event: UsageEvent) {
  if (!env.ANALYTICS) return;

  try {
    await env.ANALYTICS.prepare(
      `INSERT INTO usage_daily (
        day,
        event_name,
        outcome,
        cache_status,
        source,
        provider,
        status_code,
        event_count,
        duration_ms,
        words,
        markdown_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT (
        day,
        event_name,
        outcome,
        cache_status,
        source,
        provider,
        status_code
      ) DO UPDATE SET
        event_count = event_count + 1,
        duration_ms = duration_ms + excluded.duration_ms,
        words = words + excluded.words,
        markdown_bytes = markdown_bytes + excluded.markdown_bytes`,
    )
      .bind(
        new Date().toISOString().slice(0, 10),
        event.eventName,
        event.outcome || "",
        event.cacheStatus || "",
        event.source || "",
        event.provider || "",
        finiteInteger(event.statusCode),
        finiteInteger(event.durationMs),
        finiteInteger(event.words),
        finiteInteger(event.markdownBytes),
      )
      .run();
  } catch (error) {
    console.warn("usage_event_failed", {
      eventName: event.eventName,
      message: error instanceof Error ? error.message : "unknown error",
    });
  }
}
