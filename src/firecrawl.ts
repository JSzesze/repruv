import { readTextLimited } from "./bounded-body";
import { htmlToReadableMarkdown } from "./extract";
import { ExtractionFailure } from "./failures";
import type { StoredExtraction } from "./types";

export async function extractFirecrawl(url: string, apiKey: string, ttl: number): Promise<StoredExtraction> {
  const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats: ["html", "markdown"], onlyMainContent: true, timeout: 20000 }),
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ExtractionFailure("UPSTREAM_ERROR", `Firecrawl returned HTTP ${response.status}.`);
  }
  const payload = JSON.parse((await readTextLimited(response, 6 * 1024 * 1024)).body) as {
    success?: boolean;
    data?: { html?: string; markdown?: string; metadata?: { title?: string; author?: string; sourceURL?: string } };
  };
  const data = payload.data;
  if (!payload.success || !data) throw new ExtractionFailure("NO_CONTENT", "Firecrawl returned no article.");
  const converted = data.html?.trim() ? await htmlToReadableMarkdown(data.html, url) : null;
  const markdown = converted?.markdown || data.markdown || "";
  const now = Date.now();
  return {
    author: converted?.author || data.metadata?.author || null,
    expiresAt: new Date(now + ttl * 1000).toISOString(), fetchedAt: new Date(now).toISOString(),
    finalUrl: url, sourceUrl: url, title: converted?.title || data.metadata?.title || new URL(url).hostname,
    markdown, provider: "firecrawl", version: 1,
    stats: { markdownBytes: new TextEncoder().encode(markdown).byteLength, words: markdown.trim().split(/\s+/).filter(Boolean).length },
  };
}
