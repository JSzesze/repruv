export type ExtractionProvider =
  | "browser-run"
  | "direct-html"
  | "native-markdown"
  | "x-fxtwitter";

export interface ExtractionStats {
  markdownBytes: number;
  sourceBytes?: number;
  words: number;
}

export interface StoredExtraction {
  author: string | null;
  expiresAt: string;
  fetchedAt: string;
  finalUrl: string;
  markdown: string;
  provider: ExtractionProvider;
  sourceUrl: string;
  stats: ExtractionStats;
  title: string;
  version: 1;
}

export interface ExtractionResponse extends StoredExtraction {
  cache: {
    ageSeconds: number;
    key: string;
    status: "HIT" | "MISS" | "STALE";
  };
}

export interface BrowserRunBinding {
  quickAction(
    action: "markdown",
    input: Record<string, unknown>,
  ): Promise<Response>;
}

export interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  BROWSER?: BrowserRunBinding;
  CACHE_TTL_SECONDS?: string;
  ENABLE_BROWSER_FALLBACK?: string;
  MISS_LIMITER?: RateLimitBinding;
  RESULTS: R2Bucket;
}
