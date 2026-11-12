# Cheap, reliable, consistent extraction

## Decision

Use Cloudflare as the default host for the public Repruv service, its shared cache,
and direct extraction. Retain the tested, separate Convex backend as an optional
compute path. The observed production failure was CPU exhaustion, with zero memory
limit errors in the same dashboard window. Workers Paid is now active and the
Worker has an explicit 5,000 ms CPU ceiling; no compute migration is needed for
the verified sample.

Prioritize one predictable extraction contract and bounded fallback costs. This
is the target design; the implementation status below distinguishes working code
from the remaining work.

## Request path

1. Normalize the URL and look up its saved extraction. Return a fresh accepted
   result without running any extractor.
2. Coalesce simultaneous misses for the same URL into one extraction job.
3. Fetch and extract directly with the cleaned-up Repruv engine. Preserve article
   title/author metadata, prose, headings, code, links, tables and relevant images.
4. Apply the same validation and output normalization to every extraction path.
   Empty output, bot challenges and obvious page chrome are failures. Flag an
   identifiable preview/paywall as partial; a nonempty body is not proof of a
   complete article. Short legitimate articles must remain valid.
5. Use rendering for pages that need JavaScript. Allow at most one paid-provider
   fallback when the earlier paths fail and the configured budget permits it.
   Do not run all providers for every URL or merge unrelated provider outputs.
6. Save the accepted result, actual extraction provider, extractor version and
   retrieval time. Repeated reads use that saved result. Immutable revisions and
   content hashes remain future work.
7. If refresh fails, serve a previously accepted result with explicit stale
   metadata. Without a usable result, return a typed failure or labeled preview.
   A failure must never replace an accepted article with a bot page or site shell.

## Cost and reliability controls

- Keep browser/provider calls behind explicit enablement and per-day/month
  allowance settings. Reaching a budget limit returns cached content or a typed
  failure instead of starting an unbounded chain of paid requests.
- Rate-limit public misses, bound request size and runtime, and limit concurrent
  expensive work. Cache hits do not consume the extraction allowance.
- Retry only transient failures, with a small retry limit and backoff. Briefly
  cache repeated failures to avoid repeatedly charging for a known blocked URL.
- Use deterministic cleanup and a common response schema. Provider changes must
  pass the same fixture checks before rollout.
- Preserve public URL/DNS/redirect checks across direct, rendered and remote
  extraction paths.

## Verify before changing production

Expand the corpus beyond the initial five pages: include short and long articles,
newsletters, news sites, technical posts, code/tables/images, non-English content,
JavaScript pages, redirects, paywalls and blocked responses. Store synthetic or
appropriately licensed snapshots for repeatable offline checks and run a smaller
explicit live sample separately.

Inspect the Cloudflare invocation outcome for error 1102 to distinguish CPU from
memory exhaustion. Benchmark the cleaned-up Worker with an appropriate CPU budget
before deciding to offload extraction. Both plans retain a 128 MB Worker memory
limit; a paid CPU allowance cannot fix a memory failure.

Track accepted extraction rate, partial/blocked results, paid fallback share,
cost per 1,000 uncached URLs, latency and fixture regressions. Include browser,
provider, storage and bandwidth usage when measuring cost.

## Current implementation

Deployed to the public Cloudflare Worker on November 11, 2026. The extraction
engine preserves metadata and article introductions, rejects known challenges,
streams scripts/styles out before DOM construction, bounds HTML size and element
count, and uses a versioned cache namespace. One Durable Object per normalized URL
coordinates misses and persists short failure cooldowns; accepted results are
committed to a SQLite handoff before replying, then transferred to R2 in the
background with durable retries. Transient direct failures
receive one retry. All output paths pass the same normalization and validation.

Separate SQLite ledgers cap browser calls at 20/day and 300/month, with two
simultaneous calls. Explicit paywall markers label results `preview`; other
accepted content is labeled `article`, which is not a completeness guarantee.
An optional Firecrawl fallback is implemented but disabled: no production key and
zero allowances. The Convex development bridge is also disabled in production.

The corpus includes 17 synthetic article layouts, supplemented by adapter, safety,
and Cloudflare runtime tests. Four of the five public sample pages return content;
Medium is explicitly blocked. Editorial callouts and accessible public accordion answers are preserved after
the GitHub/BibleProject follow-up. The service still uses TTL-based cache entries,
not immutable revision history. See [CLOUDFLARE_FIX_REPORT.md](./CLOUDFLARE_FIX_REPORT.md)
for deployment evidence and remaining limits.

## Platform references

- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare CPU and memory limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Convex Node runtime](https://docs.convex.dev/functions/runtimes)
- [Convex prototype and cutover notes](./CONVEX_MIGRATION.md)
