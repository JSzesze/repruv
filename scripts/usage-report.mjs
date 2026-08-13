import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SITE = "https://repruv.com";
const ZONE = "repruv.com";
const ANALYTICS_DATABASE = "repruv-analytics";
const WINDOW_DAYS = 3;

function isoDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
}

function shiftDays(date, days) {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}

function shiftUtcDay(day, days) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function percentageChange(current, previous) {
  if (previous === 0) return current === 0 ? "0%" : "new";
  return `${(((current - previous) / previous) * 100).toFixed(1)}%`;
}

function wranglerToken() {
  try {
    execFileSync(join(process.cwd(), "node_modules/.bin/wrangler"), ["whoami"], {
      stdio: "ignore",
    });
  } catch {
    // The existing token may still be valid even if the refresh check is unavailable.
  }

  const config = readFileSync(
    join(homedir(), "Library/Preferences/.wrangler/config/default.toml"),
    "utf8",
  );
  const token = config.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
  if (!token) throw new Error("Wrangler OAuth token not found. Run `wrangler login` first.");
  return token;
}

async function cloudflareJson(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const responseText = await response.text();
  const body = responseText ? JSON.parse(responseText) : {};
  if (!response.ok || body.errors?.length) {
    throw new Error(body.errors?.[0]?.message || `Cloudflare request failed (${response.status})`);
  }
  return body;
}

async function zoneTag(token) {
  const body = await cloudflareJson(
    `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(ZONE)}`,
    token,
  );
  const id = body.result?.[0]?.id;
  if (!id) throw new Error(`Cloudflare zone not found: ${ZONE}`);
  return id;
}

async function analyticsDay(token, zone, start, end) {
  const query = `
    query RepruvUsageDay(
      $zoneTag: string
      $start: Time
      $end: Time
    ) {
      viewer {
        zones(filter: { zoneTag: $zoneTag }) {
          period: httpRequestsAdaptiveGroups(
            limit: 10000
            filter: {
              datetime_geq: $start
              datetime_lt: $end
              requestSource: "eyeball"
              OR: [
                { clientRequestPath: "/" }
                { clientRequestPath: "/api/extract" }
                { clientRequestPath: "/api/markdown" }
              ]
            }
          ) {
            count
            sum { visits }
            dimensions { clientRequestPath edgeResponseStatus }
          }
        }
      }
    }
  `;

  const body = await cloudflareJson("https://api.cloudflare.com/client/v4/graphql", token, {
    method: "POST",
    body: JSON.stringify({
      query,
      variables: { zoneTag: zone, start, end },
    }),
  });
  const data = body.data?.viewer?.zones?.[0];
  if (!data) throw new Error("No Cloudflare analytics returned for the Repruv zone.");
  return data.period || [];
}

function summarize(rows) {
  const totals = {
    apiAttempts: 0,
    apiClientErrors: 0,
    apiServerErrors: 0,
    apiSuccesses: 0,
    homepageRequests: 0,
    visits: 0,
  };

  for (const row of rows) {
    const count = Number(row.count || 0);
    const path = row.dimensions?.clientRequestPath;
    const status = Number(row.dimensions?.edgeResponseStatus || 0);
    if (path === "/") {
      totals.homepageRequests += count;
      totals.visits += Number(row.sum?.visits || 0);
      continue;
    }
    if (path !== "/api/extract" && path !== "/api/markdown") continue;
    totals.apiAttempts += count;
    if (status >= 200 && status < 300) totals.apiSuccesses += count;
    else if (status >= 400 && status < 500) totals.apiClientErrors += count;
    else if (status >= 500) totals.apiServerErrors += count;
  }

  return totals;
}

function d1UsageRows(start, end) {
  const sql = `SELECT
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
  FROM usage_daily
  WHERE day >= '${start.slice(0, 10)}'
    AND day < '${end.slice(0, 10)}'
  ORDER BY day, event_name, outcome`;
  const output = execFileSync(
    join(process.cwd(), "node_modules/.bin/wrangler"),
    ["d1", "execute", ANALYTICS_DATABASE, "--remote", "--command", sql, "--json"],
    { encoding: "utf8" },
  );
  const batches = JSON.parse(output);
  return batches.flatMap((batch) => batch.results || []);
}

function summarizeFirstParty(rows) {
  const totals = {
    browserPageLoads: 0,
    cacheHits: 0,
    cacheMisses: 0,
    clientSubmits: 0,
    conversionAttempts: 0,
    conversionErrors: 0,
    conversionSuccesses: 0,
    copies: 0,
    downloads: 0,
    durationMs: 0,
    inputEngagements: 0,
    markdownBytes: 0,
    pageLoadsBySource: {},
    validationErrors: 0,
    words: 0,
  };

  for (const row of rows) {
    const count = Number(row.event_count || 0);
    switch (row.event_name) {
      case "browser_page_view":
        totals.browserPageLoads += count;
        totals.pageLoadsBySource[row.source || "unknown"] =
          (totals.pageLoadsBySource[row.source || "unknown"] || 0) + count;
        continue;
      case "conversion_submit":
        totals.clientSubmits += count;
        continue;
      case "copy_markdown":
        totals.copies += count;
        continue;
      case "download_markdown":
        totals.downloads += count;
        continue;
      case "input_engaged":
        totals.inputEngagements += count;
        continue;
      default:
        break;
    }
    if (row.event_name !== "conversion") continue;
    if (row.outcome === "missing_url" || row.outcome === "invalid_url") {
      totals.validationErrors += count;
      continue;
    }
    totals.conversionAttempts += count;
    totals.durationMs += Number(row.duration_ms || 0);
    if (row.outcome === "success") {
      totals.conversionSuccesses += count;
      totals.markdownBytes += Number(row.markdown_bytes || 0);
      totals.words += Number(row.words || 0);
      if (row.cache_status === "MISS") totals.cacheMisses += count;
      else if (row.cache_status === "HIT" || row.cache_status === "STALE") {
        totals.cacheHits += count;
      }
    } else {
      totals.conversionErrors += count;
    }
  }

  return totals;
}

async function technicalSeo() {
  const guidePaths = [
    "/url-to-markdown/",
    "/webpage-to-markdown/",
    "/x-to-markdown/",
  ];
  const [root, robots, sitemap, image, www, ...guideResponses] = await Promise.all([
    fetch(`${SITE}/`, { headers: { "User-Agent": "repruv-monitor/1.0" } }),
    fetch(`${SITE}/robots.txt`, { headers: { "User-Agent": "repruv-monitor/1.0" } }),
    fetch(`${SITE}/sitemap.xml`, { headers: { "User-Agent": "repruv-monitor/1.0" } }),
    fetch(`${SITE}/og.png`, { headers: { "User-Agent": "repruv-monitor/1.0" } }),
    fetch(`https://www.repruv.com/`, {
      headers: { "User-Agent": "repruv-monitor/1.0" },
      redirect: "manual",
    }),
    ...guidePaths.map((path) =>
      fetch(`${SITE}${path}`, { headers: { "User-Agent": "repruv-monitor/1.0" } }),
    ),
  ]);
  const [html, robotsText, sitemapText, ...guideHtml] = await Promise.all([
    root.text(),
    robots.text(),
    sitemap.text(),
    ...guideResponses.map((response) => response.text()),
  ]);

  return {
    canonical: /<link rel="canonical" href="https:\/\/repruv\.com\/"\s*\/>/.test(html),
    description: /<meta\s+name="description"/m.test(html),
    jsonLd: /<script type="application\/ld\+json">/.test(html),
    ogImage: image.ok && (image.headers.get("content-type") || "").startsWith("image/"),
    robots: robots.ok && robotsText.includes("Sitemap: https://repruv.com/sitemap.xml"),
    root: root.ok,
    sitemap:
      sitemap.ok &&
      ["/", ...guidePaths].every((path) =>
        sitemapText.includes(`<loc>${SITE}${path}</loc>`),
      ),
    urlGuide:
      guideResponses[0]?.ok &&
      guideHtml[0]?.includes('<h1>URL to Markdown</h1>') &&
      guideHtml[0]?.includes(`rel="canonical" href="${SITE}${guidePaths[0]}"`),
    webpageGuide:
      guideResponses[1]?.ok &&
      guideHtml[1]?.includes('<h1>Webpage to Markdown</h1>') &&
      guideHtml[1]?.includes(`rel="canonical" href="${SITE}${guidePaths[1]}"`),
    wwwRedirect:
      www.status === 308 && www.headers.get("location") === "https://repruv.com/",
    xGuide:
      guideResponses[2]?.ok &&
      guideHtml[2]?.includes('<h1>X post to Markdown</h1>') &&
      guideHtml[2]?.includes(`rel="canonical" href="${SITE}${guidePaths[2]}"`),
  };
}

const now = new Date();
const currentEnd = isoDay(now);
const currentStart = isoDay(shiftDays(now, -WINDOW_DAYS));
const previousStart = isoDay(shiftDays(now, -(WINDOW_DAYS * 2)));
const token = wranglerToken();
const zone = await zoneTag(token);
const dayStarts = Array.from({ length: WINDOW_DAYS * 2 }, (_, index) =>
  isoDay(shiftDays(now, index - WINDOW_DAYS * 2)),
);
const dailyRows = [];
for (const [index, start] of dayStarts.entries()) {
  dailyRows.push(
    await analyticsDay(
      token,
      zone,
      start,
      index === dayStarts.length - 1 ? currentEnd : dayStarts[index + 1],
    ),
  );
}
const seo = await technicalSeo();
const previous = summarize(dailyRows.slice(0, WINDOW_DAYS).flat());
const current = summarize(dailyRows.slice(WINDOW_DAYS).flat());
const firstPartyPrevious = summarizeFirstParty(d1UsageRows(previousStart, currentStart));
const firstPartyCurrent = summarizeFirstParty(d1UsageRows(currentStart, currentEnd));
const utcToday = new Date().toISOString().slice(0, 10);
const firstPartyToday = summarizeFirstParty(
  d1UsageRows(utcToday, shiftUtcDay(utcToday, 1)),
);
const checks = Object.entries(seo);
const healthy = checks.filter(([, value]) => value).length;

console.log(`# Repruv weekly usage and SEO report`);
console.log(`\nComplete days: ${currentStart.slice(0, 10)} through ${currentEnd.slice(0, 10)} (exclusive end)`);
console.log(`\n| Metric | Last ${WINDOW_DAYS} days | Prior ${WINDOW_DAYS} days | Change |`);
console.log(`| --- | ---: | ---: | ---: |`);
for (const [label, key] of [
  ["Visits", "visits"],
  ["Homepage requests", "homepageRequests"],
  ["Conversion endpoint requests", "apiAttempts"],
  ["Successful endpoint responses", "apiSuccesses"],
  ["Endpoint client errors", "apiClientErrors"],
  ["Endpoint server errors", "apiServerErrors"],
]) {
  console.log(
    `| ${label} | ${current[key]} | ${previous[key]} | ${percentageChange(current[key], previous[key])} |`,
  );
}

console.log(`\nTechnical SEO: ${healthy}/${checks.length} checks passing`);
for (const [name, passing] of checks) console.log(`- ${passing ? "PASS" : "FAIL"}: ${name}`);

if (current.apiAttempts === 0) {
  console.log(`\nObservation: no one used the conversion endpoints during this period.`);
} else {
  const responseRate = ((current.apiSuccesses / current.apiAttempts) * 100).toFixed(1);
  console.log(`\nObservation: endpoint 2xx response rate was ${responseRate}%. This includes malformed or automated requests.`);
}

console.log(`\n## Privacy-safe first-party counters`);
console.log(`\nThese counters began when D1 telemetry was deployed; they use no URLs, IPs, cookies, or user-agent strings.`);
console.log(`\n| Metric | Last ${WINDOW_DAYS} days | Prior ${WINDOW_DAYS} days | Change |`);
console.log(`| --- | ---: | ---: | ---: |`);
for (const [label, key] of [
  ["Browser page loads", "browserPageLoads"],
  ["Input engagements", "inputEngagements"],
  ["Browser submits", "clientSubmits"],
  ["Completed conversion attempts", "conversionAttempts"],
  ["Successful conversions", "conversionSuccesses"],
  ["Completed conversion errors", "conversionErrors"],
  ["Validation rejections", "validationErrors"],
  ["Cache hits", "cacheHits"],
  ["Cache misses", "cacheMisses"],
  ["Copies", "copies"],
  ["Downloads", "downloads"],
]) {
  console.log(
    `| ${label} | ${firstPartyCurrent[key]} | ${firstPartyPrevious[key]} | ${percentageChange(firstPartyCurrent[key], firstPartyPrevious[key])} |`,
  );
}
if (firstPartyCurrent.conversionAttempts > 0) {
  const successRate = (
    (firstPartyCurrent.conversionSuccesses / firstPartyCurrent.conversionAttempts) * 100
  ).toFixed(1);
  console.log(`\nCompleted conversion success rate: ${successRate}%.`);
  console.log(
    `\nAverage conversion latency: ${Math.round(firstPartyCurrent.durationMs / firstPartyCurrent.conversionAttempts)} ms`,
  );
}

console.log(`\nCurrent UTC day (${utcToday}, partial):`);
console.log(`- Browser page loads: ${firstPartyToday.browserPageLoads}`);
for (const [source, count] of Object.entries(firstPartyToday.pageLoadsBySource)) {
  console.log(`  - ${source}: ${count}`);
}
console.log(`- Input engagements: ${firstPartyToday.inputEngagements}`);
console.log(`- Browser submits: ${firstPartyToday.clientSubmits}`);
console.log(`- Completed conversion attempts: ${firstPartyToday.conversionAttempts}`);
console.log(`- Successful conversions: ${firstPartyToday.conversionSuccesses}`);
console.log(`- Completed conversion errors: ${firstPartyToday.conversionErrors}`);
console.log(`- Validation rejections: ${firstPartyToday.validationErrors}`);
console.log(`- Cache hits / misses: ${firstPartyToday.cacheHits} / ${firstPartyToday.cacheMisses}`);
console.log(`- Copies / downloads: ${firstPartyToday.copies} / ${firstPartyToday.downloads}`);
