import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SITE = "https://repruv.com";
const ZONE = "repruv.com";
const WINDOW_DAYS = 3;

function isoDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
}

function shiftDays(date, days) {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
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

async function technicalSeo() {
  const [root, robots, sitemap, image, www] = await Promise.all([
    fetch(`${SITE}/`, { headers: { "User-Agent": "repruv-monitor/1.0" } }),
    fetch(`${SITE}/robots.txt`, { headers: { "User-Agent": "repruv-monitor/1.0" } }),
    fetch(`${SITE}/sitemap.xml`, { headers: { "User-Agent": "repruv-monitor/1.0" } }),
    fetch(`${SITE}/og.png`, { headers: { "User-Agent": "repruv-monitor/1.0" } }),
    fetch(`https://www.repruv.com/`, {
      headers: { "User-Agent": "repruv-monitor/1.0" },
      redirect: "manual",
    }),
  ]);
  const [html, robotsText, sitemapText] = await Promise.all([
    root.text(),
    robots.text(),
    sitemap.text(),
  ]);

  return {
    canonical: /<link rel="canonical" href="https:\/\/repruv\.com\/"\s*\/>/.test(html),
    description: /<meta\s+name="description"/m.test(html),
    jsonLd: /<script type="application\/ld\+json">/.test(html),
    ogImage: image.ok && (image.headers.get("content-type") || "").startsWith("image/"),
    robots: robots.ok && robotsText.includes("Sitemap: https://repruv.com/sitemap.xml"),
    root: root.ok,
    sitemap: sitemap.ok && sitemapText.includes("<loc>https://repruv.com/</loc>"),
    wwwRedirect:
      www.status === 308 && www.headers.get("location") === "https://repruv.com/",
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
const checks = Object.entries(seo);
const healthy = checks.filter(([, value]) => value).length;

console.log(`# Repruv weekly usage and SEO report`);
console.log(`\nComplete days: ${currentStart.slice(0, 10)} through ${currentEnd.slice(0, 10)} (exclusive end)`);
console.log(`\n| Metric | Last ${WINDOW_DAYS} days | Prior ${WINDOW_DAYS} days | Change |`);
console.log(`| --- | ---: | ---: | ---: |`);
for (const [label, key] of [
  ["Visits", "visits"],
  ["Homepage requests", "homepageRequests"],
  ["Conversion attempts", "apiAttempts"],
  ["Successful conversions", "apiSuccesses"],
  ["Conversion client errors", "apiClientErrors"],
  ["Conversion server errors", "apiServerErrors"],
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
  const successRate = ((current.apiSuccesses / current.apiAttempts) * 100).toFixed(1);
  console.log(`\nObservation: conversion success rate was ${successRate}%.`);
}
