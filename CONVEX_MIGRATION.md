# Convex extraction backend

This is a verified optional backend. The production direction is Cloudflare first,
with bounded extraction fallbacks and a common article contract; see
[EXTRACTION_DESIGN.md](./EXTRACTION_DESIGN.md). The Worker failure has been identified as CPU exhaustion. Workers Paid and the
bounded Cloudflare extraction path resolve the tested case; this bridge remains
an inactive development prototype.

Repruv has a separate Convex project: [jason-szesze/repruv](https://dashboard.convex.dev/t/jason-szesze/repruv).
Its development deployment is `striped-mosquito-364`. The current public site
continues to run on the existing Cloudflare Worker. No production switch has occurred.

## Runtime split when the optional bridge is enabled

1. The Worker serves public pages and the existing `/api/extract`, `/api/markdown`
   and `/md` routes. Edge/R2 cache hits return without calling Convex.
2. A rate-limited cache miss calls Convex's private `/internal/extract` HTTP route.
   A shared secret is required; the underlying Node action is internal.
3. The Node action fetches the public URL and runs the same slim-HTML/Defuddle
   extractor, with the existing URL, DNS, redirect and source-size checks.
4. If rendering is needed, the Node action calls the Worker's private
   `/api/internal/browser` relay. The Worker uses its existing Browser Run binding;
   rendered HTML returns to Node for extraction. No Cloudflare account token needs
   to be copied into Convex.
5. The Worker stores successful results in the existing cache and records its
   existing D1 conversion metrics. Failures can use an existing stale cache entry.

The cache namespace is now `results/v4/`, avoiding previous entries with lost
titles, cached verification pages, or omitted callout/accordion content. Old R2
objects are not deleted by this change.

Convex's Node runtime provides 512 MiB and up to ten minutes per action. Its HTTP
runtime cannot directly run Node libraries, hence the separate HTTP route and
internal Node action. See [runtimes](https://docs.convex.dev/functions/runtimes)
and [limits](https://docs.convex.dev/production/state/limits).

Keeping hot cache delivery at Cloudflare avoids a Convex call on every read.
At an assumed 1–2 seconds per Node action, 100,000 misses use about 14–28 GB-hours,
or roughly $4–$9 in compute before included allowances. Function calls, bandwidth
and browser rendering are additional, and included usage is shared with the team.
These are estimates using [current pricing](https://www.convex.dev/pricing), not a
bill forecast or a production load benchmark.

## Earlier prototype verification on November 11, 2026

- At prototype verification, 31 offline tests passed, including article metadata/introduction text,
  HTML/Markdown/browser challenge rejection, proxy authentication and browser-relay
  restrictions. Four live tests are opt-in and skipped by the regular suite.
- The root and Convex TypeScript checks pass. The Worker dry-run build succeeds.
- Four real pages passed local Node extraction: Paul Graham, DEV, One Useful Thing
  and Wikipedia. The DEV title is corrected and the newsletter returns content.
- Four authenticated requests through the actual Convex development HTTP endpoint
  returned content in 759–2,276 ms, measured at the client. Unauthorized requests
  returned 401. These timings include network fetches and do not separate cold
  starts or server compute time.
- The private bridge secret is stored in the development deployment and ignored,
  mode-0600 `.dev.vars`. It is not in source control or console output.
- A real request through the local Worker reached Convex, returned the newsletter
  with `X-Cache: MISS`, then returned `X-Cache: HIT` on the repeat request.

Full outputs and timing data are local under `.test-output/convex-http/`; the
four-page timing snapshot is `verified-summary.json`. The shared Savit comparison
also exercised the local Worker/Convex route: four pages returned content, while
Medium failed. Direct requests for that Medium page received a non-JSON gateway
failure; the bridge reports its HTTP status instead of a JSON parsing error.
Browser rendering through the deployed Worker relay still needs a live verification
after that Worker version is deployed. Medium may continue to block automation;
those responses must remain failures rather than successful article results.

## Development

```sh
npm install
npm run convex:dev
npx wrangler d1 migrations apply repruv-analytics --local --config wrangler.local.jsonc
npm run dev:local
npm run sample:convex
npm run test:live
```

`.dev.vars` supplies `CONVEX_SITE_URL` and `REPRUV_PROXY_SECRET` to the local Worker
and sampler. The same secret must be set on the selected Convex deployment.
Without `REPRUV_EDGE_URL` on Convex, browser fallback is disabled; direct extraction
continues to work. Never point production traffic at the development deployment.

## Production status

Wrangler access has been restored. The updated public Cloudflare Worker is
deployed and uses local extraction, with no `CONVEX_SITE_URL` or bridge secret in
production. The separate Convex development backend remains available for future
experiments. No Savit deployment was changed and no Convex production deployment
or migration is required by the current plan.

If a future measured workload requires Node compute, first publish and verify a
separate production Convex deployment, configure separate production credentials,
and explicitly select it with `CONVEX_SITE_URL`. Never use the development endpoint
for public traffic. The development bridge verification above does not establish
production rendering or production load performance.
