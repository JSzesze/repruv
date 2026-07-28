# Repruv launch checklist

The product, sitemap, canonical URLs, structured data, social image, and privacy-safe funnel telemetry are ready. These remaining steps require the domain owner’s search or social account.

## Search discovery

1. Add `repruv.com` as a Domain property in [Google Search Console](https://search.google.com/search-console).
2. Copy Google’s verification value into a DNS TXT record for `repruv.com`.
3. After verification, submit `https://repruv.com/sitemap.xml`.
4. Inspect and request indexing for:
   - `https://repruv.com/`
   - `https://repruv.com/url-to-markdown/`
   - `https://repruv.com/webpage-to-markdown/`
   - `https://repruv.com/x-to-markdown/`
5. Import the verified Search Console property into [Bing Webmaster Tools](https://www.bing.com/webmasters/).

IndexNow submission for Bing and other participating engines is already configured. Run
`npm run seo:indexnow` whenever one of the four public pages materially changes.

## X launch copy

> Web pages are noisy. Markdown shouldn’t be.
>
> I built Repruv: paste a public webpage or X post and get clean Markdown. No account, no API key, free to use.
>
> https://repruv.com

Attach a short recording that pastes a real article URL, shows the result, and copies the Markdown.

## Show HN

**Title**

> Show HN: Repruv – turn public webpages and X posts into Markdown

**Post**

> I built Repruv, a small URL-to-Markdown utility running on Cloudflare.
>
> Paste a public webpage or X status URL and it returns clean Markdown that can be copied or downloaded. It uses direct extraction first, Browser Run as a fallback, and shared edge/R2 caching so repeat URLs are fast.
>
> There is no account, API key, or charge to use it. Submitted URLs are not stored in analytics.
>
> Live: https://repruv.com  
> Source: https://github.com/JSzesze/repruv

## What to measure

Review `npm run report:usage` after each launch:

- Browser page loads by entry page
- Input engagement rate
- Browser submit rate
- Conversion success and latency
- Cache hits and misses
- Copy and download actions

Do not evaluate conversion rate until there is a meaningful number of tracked browser page loads.
