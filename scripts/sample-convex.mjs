import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const endpoint = new URL("/internal/extract", process.env.CONVEX_SITE_URL);
if (!process.env.REPRUV_PROXY_SECRET) throw new Error("Load .dev.vars with the private bridge secret first.");
const urls = process.argv.slice(2);
if (!urls.length) urls.push(
  "https://www.paulgraham.com/worked.html",
  "https://dev.to/ben/the-devto-search-engine-is-actually-pretty-damn-useful-1ic",
  "https://www.oneusefulthing.org/p/centaurs-and-cyborgs-on-the-jagged",
  "https://en.wikipedia.org/wiki/Markdown",
);
const directory = `.test-output/convex-http/${new Date().toISOString().replace(/[:.]/g, "-")}`;
await mkdir(directory, { recursive: true });
const summary = [];
const unauthorized = await fetch(endpoint, { method: "POST" });
if (unauthorized.status !== 401) throw new Error("Private endpoint did not reject an unauthorized request.");
for (const url of urls) {
  const started = performance.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.REPRUV_PROXY_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, ttlSeconds: 3600 }),
      signal: AbortSignal.timeout(120_000),
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`Convex endpoint returned HTTP ${response.status} without a JSON result.`);
    }
    if (!response.ok) throw new Error(result.error?.message || `HTTP ${response.status}`);
    if (!result.markdown?.trim()) throw new Error("Empty extraction");
    const id = createHash("sha256").update(url).digest("hex").slice(0, 12);
    await writeFile(`${directory}/${id}.json`, JSON.stringify(result, null, 2));
    const record = { url, title: result.title, words: result.stats.words, durationMs: Math.round(performance.now() - started), provider: result.provider, status: "ok" };
    summary.push(record);
    console.log(JSON.stringify(record));
  } catch (error) {
    const record = { url, status: "error", durationMs: Math.round(performance.now() - started), error: error.message };
    summary.push(record);
    console.log(JSON.stringify(record));
    process.exitCode = 1;
  }
}
await writeFile(`${directory}/summary.json`, JSON.stringify(summary, null, 2));
console.log(`Saved: ${directory}/summary.json`);
