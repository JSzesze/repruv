import type { StoredExtraction } from "./types";

export async function extractViaConvex(
  siteUrl: string,
  proxySecret: string | undefined,
  url: string,
  ttlSeconds: number,
): Promise<StoredExtraction> {
  if (!proxySecret) throw new Error("Convex extraction requires REPRUV_PROXY_SECRET.");
  const response = await fetch(new URL("/internal/extract", siteUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${proxySecret}` },
    body: JSON.stringify({ url, ttlSeconds }),
    signal: AbortSignal.timeout(120_000),
  });
  let payload: StoredExtraction & { error?: { message?: string } };
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Convex extraction returned HTTP ${response.status} without a JSON result.`);
  }
  if (!response.ok) throw new Error(payload.error?.message || `Convex extraction returned HTTP ${response.status}.`);
  if (payload.version !== 1 || typeof payload.markdown !== "string" || !payload.markdown.trim() || !payload.stats) {
    throw new Error("Convex extraction returned an invalid result.");
  }
  return payload;
}
