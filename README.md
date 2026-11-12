# Repruv

Paste a public webpage or X post. Get clean Markdown.

**[Try Repruv →](https://repruv.com)**

Repruv is a small, anonymous Cloudflare service extracted from the URL conversion lab in [`JSzesze/distill`](https://github.com/JSzesze/distill). It is free for end users, shares cached results across requests, and uses Browser Run only when ordinary extraction fails.

The optional Convex backend moves HTML parsing into a Node action. Cloudflare
continues to serve the site, cache results, rate-limit misses, and render pages
when needed. The separate `jason-szesze:repruv` development deployment is working;
the production site has not been switched. See [CONVEX_MIGRATION.md](./CONVEX_MIGRATION.md)
for prototype verification results and configuration.

The intended production design prioritizes cost, reliability, and consistent
article output. See [EXTRACTION_DESIGN.md](./EXTRACTION_DESIGN.md): Cloudflare is
the default. The production failure was a CPU limit; Workers Paid is active and
the cleaned-up Worker is deployed. See [CLOUDFLARE_FIX_REPORT.md](./CLOUDFLARE_FIX_REPORT.md).

- [Convert a URL to Markdown](https://repruv.com/url-to-markdown/)
- [Convert a webpage to Markdown](https://repruv.com/webpage-to-markdown/)
- [Convert an X post to Markdown](https://repruv.com/x-to-markdown/)

## API

Return JSON with Markdown and metadata:

```bash
curl --get 'https://your-domain.example/api/extract' \
  --data-urlencode 'url=https://example.com/article'
```

Return only Markdown:

```bash
curl --get 'https://your-domain.example/api/markdown' \
  --data-urlencode 'url=https://example.com/article'
```

`POST /api/extract` and `POST /api/markdown` also accept either JSON (`{"url":"…"}`) or form data. Responses include `X-Cache`, `X-Extraction-Provider`, and `X-Content-Status`
headers. `contentStatus: "preview"` indicates an explicit paywall marker; `article`
does not certify completeness. Errors have stable codes and are never cached as
articles; repeated extraction failures include `Retry-After`.

## Extraction order

1. X/Twitter URLs use the FxTwitter adapter and Distill's Draft.js-aware renderer.
2. Wikipedia article URLs use the MediaWiki parse API for content HTML (not the full site shell).
3. Other URLs request native Markdown and then fall back to HTML.
4. HTML is slimmed (chrome removed, main content preferred) and converted with Defuddle.
5. If direct extraction fails, Browser Run fetches rendered HTML for the same slim→Defuddle path; Markdown Quick Action is a last resort and chrome dumps are rejected.
6. If refresh fails but an expired cached result exists, the stale result is returned with an HTTP `Warning` header.

Article title and author metadata are preserved before removing page chrome.
Editorial callouts and accessible accordion answers present in the public HTML
are retained, including BibleProject guide summaries and FAQs.
Security verification pages are rejected in both HTML and Markdown paths, so a
bot challenge cannot be reported and cached as a successful article extraction.

## Cache model

- The normalized URL is SHA-256 hashed; fragments are ignored.
- Cloudflare's edge Cache API is the fast first layer, with a one-day TTL.
- R2 is the durable shared layer, with a seven-day freshness TTL by default.
- Fresh extractions are committed to a SQLite Durable Object before responding;
  their R2 transfer runs in the background. Pending results survive restarts,
  serve repeat callers, and retry failed R2 writes with backoff.
- Only extracted Markdown and metadata are retained. Raw HTML and provider payloads are not stored.
- Cache misses are limited to ten per minute per apparent client IP and Cloudflare location. Hits do not consume that application-level limit.

Cloudflare's Cache API requires a custom domain or route. On a `*.workers.dev` deployment the R2 layer still works, but the extra edge-cache layer is inactive.

Create an R2 lifecycle rule that deletes objects under `results/` after 30 days so one-off URLs do not accumulate forever.

## Deploy

Prerequisites: Node.js, a Cloudflare account, and Wrangler authentication.

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create url-to-markdown-cache
npm test
npm run check
npm run deploy
```

For local development:

```bash
npm install
npm run dev
```

Browser Run Quick Actions require remote development. The included Browser binding sets `remote: true`; R2 remains locally simulated by Wrangler.

To develop without Cloudflare authentication or Browser Run, use `npm run dev:local`. The direct extractor and local R2 cache still work; browser fallback is disabled.

After changing bindings, run `npx wrangler types --strict-vars false` to regenerate
the checked-in binding and runtime types. Local `.dev.vars` is never deployed.
It currently enables the optional Convex development bridge; remove those two
bridge variables locally when testing the direct Worker path.

## Operating cost and limits

“Free” describes the user experience, not an unlimited infrastructure promise.

- Workers Free currently provides 100,000 requests/day but only 10 ms CPU per invocation. Defuddle can exceed that CPU budget on complex pages, so a reliable public launch should use the $5/month Workers Paid plan.
- Browser Run Free provides 10 browser minutes/day and permits one Quick Action every ten seconds. The paid Workers plan includes 10 browser hours/month; additional usage is metered.
- R2 includes 10 GB-month storage, one million Class A operations, ten million Class B operations, and free egress each month.
- Static asset requests are free and unlimited.

The Worker uses a 5,000 ms CPU ceiling, a 5 MB source limit, a 512 KB filtered
HTML limit, and a 12,000 element limit. Repeated requests share one extraction.
Browser calls are capped at 20/day and 300/month, with two simultaneous calls and
20-second navigation timeouts. Counts include failed attempts. Firecrawl is
disabled unless a key and positive allowances are configured. These controls
bound application fallback calls; they are not a hard account billing cap.

## Security and privacy

- Only public HTTP and HTTPS URLs on ports 80 and 443 are accepted.
- Private, loopback, link-local, reserved, and internal hostnames/addresses are rejected. Every redirect is validated again.
- The service never forwards user cookies, authorization headers, or URL credentials.
- Results are public, shared cache entries. Do not submit private, expiring, paywalled, or authenticated links.
- FxTwitter is an external dependency and can change or become unavailable independently.

DNS validation and the subsequent HTTP fetch are separate operations, so URL-fetching services should still be treated as security-sensitive. Keep Wrangler and dependencies current, retain Cloudflare's network protections, and review the SSRF checks before adding authenticated fetches or custom headers.

## Configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `CACHE_TTL_SECONDS` | `604800` | R2 result freshness; clamped from one hour to 30 days |
| `ENABLE_BROWSER_FALLBACK` | `true` | Set to `false` to operate without Browser Run |
| `BROWSER_DAILY_LIMIT` | `20` | Browser Quick Actions allowed per UTC day |
| `BROWSER_MONTHLY_LIMIT` | `300` | Browser Quick Actions allowed per UTC month |
| `FALLBACK_CONCURRENCY` | `2` | Simultaneous calls per fallback provider |
| `FIRECRAWL_API_KEY` | unset | Optional paid fallback secret; disabled in production |
| `FIRECRAWL_DAILY_LIMIT` | `0` | Firecrawl calls allowed per UTC day |
| `FIRECRAWL_MONTHLY_LIMIT` | `0` | Firecrawl calls allowed per UTC month |
| `CONVEX_SITE_URL` | unset | Offload cache-miss extraction to this Convex HTTP-actions host |
| `REPRUV_PROXY_SECRET` | unset | Shared secret protecting the private Convex/Browser Run bridge |
| `REPRUV_SERVICE_TOKEN` | unset | Authenticate Savit's server calls, which use Savit's per-user quotas instead of the public IP miss limiter |

The Worker bindings are declared in `wrangler.jsonc`: `RESULTS`, `BROWSER`, `MISS_LIMITER`, `ASSETS`, `ANALYTICS`,
`EXTRACTION_COORDINATOR`, and `FALLBACK_BUDGET`. The two Durable Object classes
use the checked-in SQLite migration.

Run `npm test` and `npm run check` for offline and Workers runtime checks.
The repeatable article corpus is `fixtures/articles/cases.json`. `npm run test:live` explicitly
samples public pages in Node. `npm run sample:convex` samples the configured private
Convex endpoint using the ignored `.dev.vars` file. Live outputs are kept under
ignored `.test-output/`; none of these samples run during the regular test suite.

## SEO and product telemetry

The production site publishes a canonical URL, Open Graph and X card metadata, `WebSite` and `SoftwareApplication` structured data, a social preview image, `robots.txt`, and `sitemap.xml`. API and health responses send `X-Robots-Tag: noindex, nofollow` so only the product page is indexed.

Usage is monitored with Cloudflare zone analytics and privacy-safe first-party counters in D1. The funnel records fixed event names and page labels for browser loads, first input engagement, submit, conversion outcome, copy, and download. Server events include cache status, extraction provider, latency, word count, and output size.

The application does not store submitted URLs, URL hashes, referrers, IP addresses, cookies, or user-agent strings in its analytics data.

Run the same report locally with `npm run report:usage`. It uses the existing Wrangler OAuth session, compares the last three complete days with the preceding three (the analytics retention available on the current plan), and verifies the live canonical URL, metadata, structured data, social image, robots file, sitemap, and `www` redirect.

New and updated public pages can be submitted to IndexNow with `npm run seo:indexnow`. For Google search performance, add `https://repruv.com/` to Google Search Console and submit `https://repruv.com/sitemap.xml`. Import the verified property into Bing Webmaster Tools. Technical SEO is observable immediately; impressions, clicks, and query rankings require webmaster data after discovery.

## License

[MIT](./LICENSE)
