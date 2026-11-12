# Repruv Cloudflare fix report

Verified November 11, 2026, against the public `url-to-markdown` Worker at
[repruv.com](https://repruv.com).

## Failure and hosting decision

The Cloudflare dashboard reported **one Exceeded CPU Time Limits error and zero
memory-limit errors** in the original test window. The corresponding GraphQL
resource-error group contained one failed invocation with CPU time 82,786 µs
(82.786 ms). A later successful request does not invalidate that earlier failure.
Workers Free's small CPU allowance was unsuitable for this HTML parser.

The user upgraded Workers. The dashboard then showed the paid monthly allowances
of 10 million requests and 30 million CPU milliseconds. The deployed settings now
explicitly enforce a 5,000 ms CPU ceiling. `usage_model: standard` alone was not
used as proof of the plan. No billing settings were changed by this implementation.

Cloudflare remains the production host and extraction runtime. The separate
Convex development prototype is retained but not selected by production. No
production Convex deployment, migration, or additional provider subscription is
needed for the verified cases.

## Published implementation

Version: `0af2f53a-6508-4347-9d57-e6429fd7005a`.
Previous version: `b4f69dd3-7c59-4ac1-9c8b-322db50a9059`.

- Remove scripts, styles, templates, SVG and other non-content elements with
  Cloudflare's streaming HTMLRewriter before building the JavaScript DOM.
  Bound source size, filtered HTML, element count, request bodies and Markdown.
- Preserve article title, author and introductory text. Apply one normalization
  contract across direct, rendered and optional remote-provider output.
  Explicit paywall markers produce `contentStatus: preview`. Known challenges,
  empty bodies and obvious navigation dumps fail validation.
- Route each uncached normalized URL through its own SQLite Durable Object.
  Concurrent callers share the operation; R2 persistence completes before the
  operation is released. Fresh cache hits bypass extraction and coordination.
- Retry transient direct failures once. Persist short failure cooldowns, expose
  typed errors with `Retry-After`, and remove expired negative state by alarm.
  An accepted stale article survives refresh failures and is marked stale.
- Cap Browser Run at 20 calls per UTC day and 300 per month, with two concurrent
  calls. Failed attempts count. A rendered challenge stops further conversion of
  the same challenge. Navigation has a 20-second timeout.
- Add an optional budgeted Firecrawl fallback, disabled in production: no API key
  and zero allowances. No credentials were copied from Savit.
- Enable sampled traces, generate platform/binding types and preserve the
  existing routes, D1 analytics, R2 bucket, Browser binding and miss limiter.

The new SQLite migration creates `ExtractionCoordinator` and `FallbackBudget`.
Old R2 cache entries are retained; the extractor uses `results/v3/` keys.

## Verification

`npm run check` passed. `npm test` passed **53 tests**: 46 Node tests and 7 actual
Cloudflare runtime tests. Four separately enabled live tests remain skipped in
the regular suite. The repeatable corpus includes 15 synthetic layouts covering
short articles, headings, code, tables, images, links, Unicode, lists, previews,
quotations, metadata precedence and site chrome. Runtime tests verify concurrent
misses, one upstream fetch, SQLite failure persistence, transient retry, streamed
script removal, persistent fallback limits and stale recovery.

Wrangler 4.112.0 dry-run packaging and strict production deployment passed.
Remote settings confirmed the 5,000 ms ceiling, both Durable Object bindings,
and the absence of production Convex and Firecrawl credentials.

The five-page public comparison produced these fresh results:

| Page | Result | Provider | Client elapsed time |
| --- | --- | --- | ---: |
| Paul Graham, What I Worked On | Accepted; correct title | direct-html | 1,476 ms |
| DEV search-engine article | Accepted; corrected title | direct-html | 1,599 ms |
| One Useful Thing newsletter | Accepted; corrected title and introduction | direct-html | 1,108 ms |
| Medium daily-publishing article | Explicit `BLOCKED`, HTTP 502 | Challenge rejected | 9,235 ms |
| Wikipedia, Markdown | Accepted | MediaWiki/direct-html | 948 ms |

A separate fresh newsletter URL exercised Browser Run successfully: 6,581 ms
client elapsed time and **337 ms CPU in the extraction Durable Object**. Its
outer Worker used 8 ms CPU. Outer Worker timings exclude the extraction object's
CPU and must not be presented as the total extraction cost. These are individual
samples, not load benchmarks. All observed new-version tail events completed
without resource exhaustion or uncaught exceptions; expected blocked responses
still have HTTP 502.

Three simultaneous requests for one fresh article returned identical Markdown;
the immediate repeat returned `X-Cache: HIT` in 158 ms. JSON, Markdown and plain
share routes passed. Malformed JSON returned 400, oversized input 413, a private
URL 400 and an unauthorized private relay call 401. A blocked Medium request took
11,929 ms, then its cooldown response took 245 ms with `Retry-After: 60`; the tail
showed no second browser reservation for that repeat.

The comparison report is in the adjacent Savit workspace at
`fixtures/web-article/output/repruv-cloudflare-fixed/summary.md`. Detailed local
diagnostics, test logs, smoke results and tails are ignored under
`.test-output/diagnosis/` and `.test-output/final-tests.log`. Source changes remain
in the local working tree; no Git commit or push was requested.

## Remaining limits

Medium still blocks this environment. The service reports that honestly; it does
not bypass authentication or guarantee every publisher can be extracted. The
sample checks readable output and selected content, not universal completeness.
`article` is not a full-content certification. Cache entries use a freshness TTL;
immutable revision history is not implemented. The optional Convex bridge and
Firecrawl branch have not been activated or load-tested in production.

Fallback call allowances and CPU limits control application work, not the total
Cloudflare account bill. Monitor real traffic before raising them.

Platform references:
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Durable Object RPC](https://developers.cloudflare.com/durable-objects/api/stub/).

## Follow-up: GitHub, BibleProject, Lifeway and latency

The GitHub and BibleProject checks exposed a real omission: editorial callouts
were removed as asides and collapsed FAQ answers were removed as hidden content.
Version `a02a49d0-654c-43a9-85e6-62c646fd0f49` preserves explicitly marked
editorial callouts and accessible accordion labels/regions in the reading area.
Unrelated hidden content remains excluded. Cache namespace `results/v4/` and
extractor version `2026-11-11.3` avoid serving those incomplete earlier results.

The expanded suite passed 56 regular tests (48 Node and 8 Workers), plus two
explicit live Node checks. Six live Node cases are now opt-in. The synthetic
corpus contains 17 cases. Fresh public results after that fix:

| Page | Body words | Client time | Result |
| --- | ---: | ---: | --- |
| GitHub `cli/cli` | 633 | 1,747 ms | README sections, code examples and links retained |
| BibleProject Genesis guide | 4,347 | 1,159 ms | Summary callout and all ten FAQ answers retained |
| Lifeway pastoral longevity article | 1,299 | 1,489 ms | All seven numbered article sections retained |

All three used direct HTML. The BibleProject guide previously returned 2,597
words. All 26 FAQ answer paragraphs were compared with the source HTML after
normalizing Markdown formatting and matched. Repeat GitHub and BibleProject
requests were cache hits with identical Markdown. Lifeway still includes some
social-sharing and related-product material; section coverage does not imply
perfect removal of page clutter.

Lifeway warm cache hits measured 46–109 ms after an initial 371 ms connection
sample. Direct origin retrieval measured 116 ms in curl. A separate three-request
uncached profiling sample used fresh query strings, warmed each source URL from
the test machine first, and measured 763–1,250 ms through Repruv. Those modified
URLs and the small sample are not a production latency percentile benchmark.

Version `695af55a-576d-4d28-817f-2e6314751f57` adds phase timing logs, which
contain durations but no submitted URLs. The same 56 regular tests and root
typecheck passed before publication. Cloudflare tail reported 240–453 ms CPU in
the extraction objects, 260–273 ms awaiting R2 writes, two sequential R2 reads of
roughly 40–58 ms each, and roughly 40–80 ms for source headers/body. Coordination
and client network time add further overhead. Workers clocks are frozen during
synchronous execution, so application phase logs show `parse: 0`; that is not a
zero-CPU parser. Use tail CPU measurements for that cost, and do not sum these
coarse phase numbers as an exact decomposition.

The 100–300 ms target is met by these warmed cache reads, but is not yet met by
uncached extraction. Changing where Savit persists imported articles would not
remove the parser's CPU work. Savit's existing `processWeb` action already writes
scraper output through `processing.updateMetadata` and `completeTranscript`.
It can call Repruv and save the returned result through those same mutations.
That connection has not yet replaced Savit's current extractor routing. No
Savit document was created by the samples, and no Savit schema, Convex deployment,
or production routing was changed.

Local output directories in Savit are `repruv-github-bibleproject-fixed` and
`repruv-lifeway` under `fixtures/web-article/output/`. Profiling evidence is under
Repruv's ignored `.test-output/diagnosis/latency-summary.json` and
`lifeway-uncached-profile.json`.

## Savit integration and asynchronous cache delivery

Version `21113df1-cf59-482b-a28a-b8be2e0fc260` commits accepted results into a
chunked SQLite handoff before replying. R2 writes run in the background; the
pending result survives restarts and serves subsequent callers. An alarm retries
failed transfers with backoff capped at one hour. Serialized, revision-checked
transfers prevent an old write from overwriting a newer accepted result. Pending
payloads are removed after successful R2 persistence. No new Durable Object class
or namespace migration was needed.

Streaming cleanup now removes existing navigation/sidebar/footer selectors before
DOM construction, reducing work without discarding editorial callouts or FAQs.
The typecheck and 59 regular tests passed: 48 Node and 11 Workers runtime tests.
The new cases exercise delayed R2 persistence, failed-write recovery after restart,
and large Unicode results across chunk boundaries. A real remote R2 download also
confirmed background persistence of a live Lifeway extraction.

Three fresh Lifeway profile requests measured 1,214, 844 and 734 ms at the client,
with extraction CPU of 208, 194 and 178 ms. The earlier three samples were 1,250,
1,115 and 763 ms, with CPU 447, 453 and 240 ms. These small samples use different
query strings and variable upstream timing, so they establish working behavior
and remaining costs rather than a controlled speedup or SLA. Uncached requests
still do not consistently reach 100–300 ms.

Savit's importer now calls Repruv first for ordinary articles and saves results
through its existing Convex document mutations. GitHub and X retain their
specialized adapters, Medium goes directly to Firecrawl, and Repruv failures use
the existing article providers. No Savit database credentials are installed in the Worker.
See the adjacent Savit workspace's `fixtures/web-article/INTEGRATION.md` for the exact
routing, response limits and development database save verification.

Final Worker version `76b51a57-35bb-4aae-b683-9f532aa41f40` also authenticates
Savit service calls with a dedicated `REPRUV_SERVICE_TOKEN`. Its matching secret
is configured on Savit's development and production Convex deployments. This
avoids aggregating authenticated app users under the public anonymous-IP quota;
Savit retains its existing per-user ingestion limits. Shared browser allowances
and URL safety checks remain active. Secret values were supplied through protected
files and were never added to source or command arguments. Final checks passed
60 Worker tests and 68 Savit tests, with both projects' TypeScript checks passing.

## Savit consolidation follow-up

Savit now uses one shared article router/acceptance contract and 30-second overall
deadline for imports and its Markdown lab, with actual source/provider, cache and
attempt timings persisted atomically in Convex. The backend and lab were deployed;
the adjacent `fixtures/web-article/CONSOLIDATION.md` contains the rollout report.

The R2 lookup inside the coordinator remains intentional: a runtime regression
now inserts a result between the outer miss and coordinator read, then verifies
no origin extraction occurs and a subsequent edge hit avoids another R2 read.
The typecheck and 61 regular tests passed (48 Node and 13 Workers runtime).
No new Worker runtime deployment was required for this test-only follow-up.
