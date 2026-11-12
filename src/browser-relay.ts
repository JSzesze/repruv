import { verifyProxySecret } from "./proxy-auth";
import { assertPublicUrl } from "./url";
import type { Env } from "./worker-types";
import { budgetedBrowser, type BudgetPolicyEnv } from "./fallback-policy";
import { invokeBrowser } from "./types";

/** Private bridge: Cloudflare renders HTML; Convex does the HTML/Markdown work. */
export async function relayBrowserRequest(request: Request, env: BudgetPolicyEnv & { REPRUV_PROXY_SECRET?: string }): Promise<Response> {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!await verifyProxySecret(token, env.REPRUV_PROXY_SECRET)) return new Response(null, { status: 401 });
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!env.BROWSER) return Response.json({ success: false }, { status: 503 });
  try {
    const raw = await request.text();
    if (raw.length > 8192) return new Response(null, { status: 413 });
    const input = JSON.parse(raw) as { action?: unknown; url?: unknown };
    if ((input.action !== "content" && input.action !== "markdown") || typeof input.url !== "string" || input.url.length > 4096) {
      return new Response(null, { status: 400 });
    }
    const url = await assertPublicUrl(input.url);
    const browser = budgetedBrowser(env)!;
    const response = await invokeBrowser(browser, input.action, {
      url,
      gotoOptions: { waitUntil: "networkidle2" },
      rejectRequestPattern: ["/.*\\.(css|woff2?|ttf|png|jpe?g|gif|webp|svg)(\\?.*)?$/i"],
    });
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return Response.json({ success: false }, { status: 400 });
  }
}
