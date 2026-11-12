import { DurableObject } from "cloudflare:workers";
import type { Env } from "./worker-types";

/** One ledger per month/provider; only expensive fallbacks contact this object. */
export class FallbackBudget extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)");
  }

  reserve(daily: number, monthly: number, concurrent: number): string | null {
    const day = new Date().toISOString().slice(0, 10);
    this.ctx.storage.sql.exec("DELETE FROM leases WHERE expires <= ?", Date.now());
    const dayCalls = this.ctx.storage.sql.exec<{ calls: number }>("SELECT calls FROM usage WHERE day = ?", day).toArray()[0]?.calls ?? 0;
    const total = this.ctx.storage.sql.exec<{ calls: number }>("SELECT COALESCE(SUM(calls), 0) AS calls FROM usage").one().calls;
    const running = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM leases").one().count;
    if (dayCalls >= daily || total >= monthly || running >= concurrent) return null;
    const id = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT INTO usage(day, calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET calls = calls + 1", day);
      this.ctx.storage.sql.exec("INSERT INTO leases(id, expires) VALUES (?, ?)", id, Date.now() + 120000);
    });
    return id;
  }

  release(id: string): void { this.ctx.storage.sql.exec("DELETE FROM leases WHERE id = ?", id); }
}
