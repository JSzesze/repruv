import type { ExtractionEnv } from "./types";
import type { ExtractionCoordinator } from "./coordinator";
import type { FallbackBudget } from "./fallback-budget";

interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface Env extends ExtractionEnv {
  ANALYTICS?: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  CACHE_TTL_SECONDS?: string;
  MISS_LIMITER?: RateLimitBinding;
  RESULTS: R2Bucket;
  CONVEX_SITE_URL?: string;
  REPRUV_PROXY_SECRET?: string;
  REPRUV_SERVICE_TOKEN?: string;
  EXTRACTION_COORDINATOR: DurableObjectNamespace<ExtractionCoordinator>;
  FALLBACK_BUDGET: DurableObjectNamespace<FallbackBudget>;
  BROWSER_DAILY_LIMIT?: string;
  BROWSER_MONTHLY_LIMIT?: string;
  FIRECRAWL_API_KEY?: string;
  FIRECRAWL_DAILY_LIMIT?: string;
  FIRECRAWL_MONTHLY_LIMIT?: string;
  FALLBACK_CONCURRENCY?: string;
}
