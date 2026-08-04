# Repruv

Paste a public webpage or X post. Get clean Markdown.

**[Try Repruv →](https://repruv.com)**

Repruv is a small, anonymous Cloudflare service extracted from the URL conversion lab in [`JSzesze/distill`](https://github.com/JSzesze/distill). It is free for end users, shares cached results across requests, and uses Browser Run only when ordinary extraction fails.

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

`POST /api/extract` and `POST /api/markdown` also accept either JSON (`{"url":"…"}`) or form data. Responses include `X-Cache` and `X-Extraction-Provider` headers.

## Extraction order

1. X/Twitter URLs use the FxTwitter adapter and Distill's Draft.js-aware renderer.
2. Wikipedia article URLs use the MediaWiki parse API for content HTML (not the full site shell).
3. Other URLs request native Markdown and then fall back to HTML.
4. HTML is slimmed (chrome removed, main content preferred) and converted with Defuddle.
5. If direct extraction fails, Browser Run fetches rendered HTML for the same slim→Defuddle path; Markdown Quick Action is a last resort and chrome dumps are rejected.
6. If refresh fails but an expired cached result exists, the stale result is returned with an HTTP `Warning` header.

## Cache model

- The normalized URL is SHA-256 hashed; fragments are ignored.
- Cloudflare's edge Cache API is the fast first layer, with a one-day TTL.
- R2 is the durable shared layer, with a seven-day freshness TTL by default.
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

After changing bindings, run `npx wrangler types` if you prefer generated Cloudflare types over the small checked-in declaration file.

## Operating cost and limits

“Free” describes the user experience, not an unlimited infrastructure promise.

- Workers Free currently provides 100,000 requests/day but only 10 ms CPU per invocation. Defuddle can exceed that CPU budget on complex pages, so a reliable public launch should use the $5/month Workers Paid plan.
- Browser Run Free provides 10 browser minutes/day and permits one Quick Action every ten seconds. The paid Workers plan includes 10 browser hours/month; additional usage is metered.
- R2 includes 10 GB-month storage, one million Class A operations, ten million Class B operations, and free egress each month.
- Static asset requests are free and unlimited.

Caching, the miss-only rate limiter, the 5 MB source limit, and direct-first extraction keep costs bounded. Monitor Browser Run's `X-Browser-Ms-Used` and Worker invocation metrics before increasing limits.

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

The Worker bindings are declared in `wrangler.jsonc`: `RESULTS`, `BROWSER`, `MISS_LIMITER`, and `ASSETS`.

## SEO and product telemetry

The production site publishes a canonical URL, Open Graph and X card metadata, `WebSite` and `SoftwareApplication` structured data, a social preview image, `robots.txt`, and `sitemap.xml`. API and health responses send `X-Robots-Tag: noindex, nofollow` so only the product page is indexed.

Usage is monitored with Cloudflare zone analytics and privacy-safe first-party counters in D1. The funnel records fixed event names and page labels for browser loads, first input engagement, submit, conversion outcome, copy, and download. Server events include cache status, extraction provider, latency, word count, and output size.

The application does not store submitted URLs, URL hashes, referrers, IP addresses, cookies, or user-agent strings in its analytics data.

Run the same report locally with `npm run report:usage`. It uses the existing Wrangler OAuth session, compares the last three complete days with the preceding three (the analytics retention available on the current plan), and verifies the live canonical URL, metadata, structured data, social image, robots file, sitemap, and `www` redirect.

New and updated public pages can be submitted to IndexNow with `npm run seo:indexnow`. For Google search performance, add `https://repruv.com/` to Google Search Console and submit `https://repruv.com/sitemap.xml`. Import the verified property into Bing Webmaster Tools. Technical SEO is observable immediately; impressions, clicks, and query rankings require webmaster data after discovery.

Launch copy and the account-owner indexing checklist are in [`LAUNCH.md`](./LAUNCH.md).

## License

[MIT](./LICENSE)
