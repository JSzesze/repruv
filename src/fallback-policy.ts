import { ExtractionFailure } from "./failures";
import type { BrowserRunBinding } from "./types";
import { invokeBrowser } from "./types";

export interface BudgetPolicyEnv {
  FALLBACK_BUDGET: { getByName(name: string): {
    reserve(daily: number, monthly: number, concurrent: number): Promise<string | null>;
    release(id: string): Promise<void>;
  } };
  BROWSER?: BrowserRunBinding;
  BROWSER_DAILY_LIMIT?: string;
  BROWSER_MONTHLY_LIMIT?: string;
  FIRECRAWL_DAILY_LIMIT?: string;
  FIRECRAWL_MONTHLY_LIMIT?: string;
  FALLBACK_CONCURRENCY?: string;
}

export function allowance(value: string | undefined, fallback: number, max = 10000): number {
  const parsed = value === undefined ? fallback : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(max, Math.floor(parsed))) : 0;
}

export async function withFallbackAllowance<T>(env: BudgetPolicyEnv, kind: "browser" | "firecrawl", run: () => Promise<T>): Promise<T> {
  const daily = allowance(kind === "browser" ? env.BROWSER_DAILY_LIMIT : env.FIRECRAWL_DAILY_LIMIT, kind === "browser" ? 20 : 0);
  const monthly = allowance(kind === "browser" ? env.BROWSER_MONTHLY_LIMIT : env.FIRECRAWL_MONTHLY_LIMIT, kind === "browser" ? 300 : 0);
  const concurrent = allowance(env.FALLBACK_CONCURRENCY, 2, 10);
  if (!daily || !monthly || !concurrent) throw new ExtractionFailure("BUDGET_EXHAUSTED", `${kind} fallback is disabled by its allowance.`, 503);
  const ledger = env.FALLBACK_BUDGET.getByName(`${kind}:${new Date().toISOString().slice(0, 7)}`);
  const lease = await ledger.reserve(daily, monthly, concurrent);
  if (!lease) throw new ExtractionFailure("BUDGET_EXHAUSTED", `${kind === "browser" ? "Browser" : "Firecrawl"} fallback allowance is exhausted or busy.`, 503);
  try { return await run(); }
  finally {
    try { await ledger.release(lease); }
    catch { console.warn(JSON.stringify({ event: "fallback_lease_release_failed", provider: kind })); }
  }
}

export function budgetedBrowser(env: BudgetPolicyEnv): BrowserRunBinding | undefined {
  const browser = env.BROWSER;
  if (!browser) return undefined;
  return { quickAction: (action, input) => withFallbackAllowance(env, "browser", () => invokeBrowser(browser, action, input)) };
}
