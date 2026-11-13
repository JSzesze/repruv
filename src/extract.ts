import { DOMParser, parseHTML } from "linkedom";

import type { ExtractionEnv, StoredExtraction } from "./types";
import { invokeBrowser } from "./types";
import { assertPublicUrl, isXStatusUrl, normalizeUrl } from "./url";
import { extractX } from "./x";
import { readHtmlLimited, readTextLimited } from "./bounded-body";
import { describeFailure, ExtractionFailure } from "./failures";
import { measured, type TimingObserver } from "./timing";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Cap post-slim HTML so linkedom + Defuddle stay within Worker limits. */
const MAX_SLIM_HTML_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT = "URLToMarkdown/0.1 (+https://github.com/JSzesze)";

const REMOVE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "svg",
  "nav",
  "footer",
  "aside",
  "form",
  // Wikipedia / Vector chrome
  "#mw-navigation",
  "#mw-panel",
  "#mw-head",
  "#mw-page-base",
  "#mw-head-base",
  ".vector-header-container",
  ".vector-main-menu",
  ".vector-toc",
  ".vector-column-start",
  ".vector-column-end",
  ".vector-sticky-pinned-container",
  "#p-lang-btn",
  ".mw-editsection",
  ".navbox",
  ".vertical-navbox",
  ".sistersitebox",
  ".metadata",
  ".noprint",
  "#catlinks",
  ".catlinks",
  "#footer",
  ".mw-footer",
  "#siteNotice",
  "#centralNotice",
  ".mw-indicators",
  // Common site chrome
  ".sidebar",
  "#sidebar",
  ".site-header",
  ".site-footer",
  ".cookie-banner",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
];

const CONTENT_SELECTORS = [
  "#mw-content-text .mw-parser-output",
  ".mw-parser-output",
  "#mw-content-text",
  "article",
  "main",
  "[role='main']",
  "#content",
  "#main-content",
  ".post-content",
  ".entry-content",
  ".article-content",
  ".article-body",
  ".post-body",
  ".readable-content",
];

const CHROME_MARKDOWN_SIGNALS = [
  /jump to content/i,
  /main menu/i,
  /move to sidebar/i,
  /personal tools/i,
  /skip to (?:main )?content/i,
  /toggle (?:the )?table of contents/i,
];

interface SafeFetchResult {
  body: string;
  contentType: string;
  finalUrl: string;
  sourceBytes: number;
}

let markdownDomReady = false;

function ensureMarkdownDom() {
  if (markdownDomReady) return;
  const compatibilityDom = parseHTML("<!doctype html><html><body></body></html>");
  if (!Reflect.get(globalThis, "document")) Reflect.set(globalThis, "document", compatibilityDom.document);
  if (!Reflect.get(globalThis, "window")) Reflect.set(globalThis, "window", compatibilityDom.window);
  if (!Reflect.get(globalThis, "DOMParser")) Reflect.set(globalThis, "DOMParser", DOMParser);
  markdownDomReady = true;
}

function countWords(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|~-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function titleFromMarkdown(markdown: string, url: string) {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || new URL(url).hostname;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Drop chrome and prefer a main-content root so Defuddle sees less noise
 * and stays under Worker CPU/memory limits on large pages.
 */
function publicImageUrl(value: string | null | undefined, baseUrl?: string): string | undefined {
  if (!value?.trim() || value.length > 4096) return undefined;
  try { return normalizeUrl(new URL(value.trim(), baseUrl).toString()); }
  catch { return undefined; }
}

function prepareHtmlForExtraction(html: string, baseUrl?: string) {
  const { document } = parseHTML(html);
  // Capture metadata before removing the article header or selecting its body.
  // DEV, for example, keeps the real title in a header above body H1s.
  const title =
    document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ||
    document.querySelector('meta[name="twitter:title"]')?.getAttribute("content")?.trim() ||
    document.querySelector("article header h1")?.textContent?.trim() ||
    document.querySelector("h1")?.textContent?.trim() ||
    document.querySelector("title")?.textContent?.trim() ||
    "";
  // Keep artwork metadata even when the article body scorer drops a header hero.
  const coverImage = [
    'meta[property="og:image:secure_url"]', 'meta[property="og:image"]',
    'meta[name="twitter:image"]', 'meta[property="twitter:image"]',
  ].map(selector => publicImageUrl(document.querySelector(selector)?.getAttribute("content"), baseUrl)).find(Boolean);
  const author = document.querySelector('meta[name="author"]')?.getAttribute("content")?.trim() || null;

  // Editorial callouts can use <aside> inside the reading content. Preserve
  // explicitly marked callouts while the normal cleanup still drops sidebars.
  for (const aside of Array.from(document.querySelectorAll("article aside, main aside, [role='main'] aside"))) {
    if (!aside.closest("[class*='callout']")) continue;
    const callout = document.createElement("div");
    callout.innerHTML = aside.innerHTML;
    aside.replaceWith(callout);
  }

  // Accessible accordions already contain their public answers in the HTML.
  // Flatten only a label and its associated content region inside the article;
  // unrelated hidden content and navigation panels keep their normal treatment.
  for (const button of Array.from(document.querySelectorAll("button[aria-controls][aria-expanded]")).reverse()) {
    const scope = button.closest("article, main, [role='main']");
    if (!scope || button.closest("nav, footer, form, [role='navigation'], [role='tablist']")) continue;
    const panel = document.getElementById(button.getAttribute("aria-controls") || "");
    const labels = panel?.getAttribute("aria-labelledby")?.split(/\s+/) || [];
    if (!panel || panel.getAttribute("role") !== "region" || !button.id || !labels.includes(button.id)
      || !scope.contains(panel) || !button.parentElement?.parentElement?.contains(panel)) continue;
    const heading = document.createElement("h3");
    heading.textContent = button.textContent?.trim() || "";
    const answer = document.createElement("div");
    answer.innerHTML = panel.innerHTML;
    button.replaceWith(heading);
    panel.replaceWith(answer);
  }

  // Query once instead of walking the full source tree for each selector.
  document.querySelectorAll(REMOVE_SELECTORS.join(","))
    .forEach((element: { remove(): void }) => element.remove());

  // Defuddle drops semantic header elements. Keep article introductions while
  // the selectors above still remove the site's navigation/header chrome.
  for (const header of Array.from(document.querySelectorAll("article header"))) {
    const intro = document.createElement("div");
    intro.innerHTML = header.innerHTML;
    header.replaceWith(intro);
  }

  let root = null as ReturnType<typeof document.querySelector>;
  for (const selector of CONTENT_SELECTORS) {
    const candidate = document.querySelector(selector);
    if (candidate && (candidate.textContent?.trim().length || 0) > 80) {
      root = candidate;
      break;
    }
  }
  if (!root) root = document.body;
  if (!root) return { document, title, author, coverImage };

  // Reuse the parsed document for Defuddle rather than serializing/reparsing it.
  if (root !== document.body) document.body.replaceChildren(root);
  document.head.innerHTML = `<meta charset="utf-8"><title>${escapeHtml(title)}</title>${author ? `<meta name="author" content="${escapeHtml(author)}">` : ""}${coverImage ? `<meta property="og:image" content="${escapeHtml(coverImage)}">` : ""}`;
  return { document, title, author, coverImage };
}

export function slimHtmlForExtraction(html: string): string {
  return prepareHtmlForExtraction(html).document.toString();
}

export function looksLikeChromeDump(markdown: string): boolean {
  const head = markdown.slice(0, 2_000);
  const hits = CHROME_MARKDOWN_SIGNALS.filter((pattern) => pattern.test(head)).length;
  // Two+ chrome phrases near the top = site chrome, not the article.
  return hits >= 2;
}

export function looksLikeChallengePage(content: string): boolean {
  // Avoid treating an article about bot protection as a challenge page. These
  // are page titles/headings, not an arbitrary mention within article prose.
  const heading = /(?:^#{1,3}\s+|<(?:title|h[1-3])[^>]*>\s*)(?:Performing security verification|Just a moment(?:\.{3}|…)?|Verify (?:you are|that you are) human|Checking your browser)(?:\s|<|$)/im;
  return heading.test(content.slice(0, 100_000)) || /\b(?:id=["']challenge-form["']|class=["'][^"']*cf-challenge|id=["']cf-challenge-running["'])/i.test(content);
}

function assertReadableContent(content: string) {
  if (looksLikeChallengePage(content)) {
    throw new Error("The website returned a security verification page instead of article content.");
  }
  if (looksLikeChromeDump(content)) {
    throw new Error("Readable content could not be isolated from page chrome.");
  }
}

export async function htmlToReadableMarkdown(html: string, url: string) {
  if (looksLikeChallengePage(html)) {
    throw new Error("The website returned a security verification page instead of article content.");
  }
  // Browser-returned HTML has not gone through the streamed source filter.
  if (typeof HTMLRewriter !== "undefined" && /<(?:script|style|svg|iframe|noscript|template)\b/i.test(html)) {
    html = (await readHtmlLimited(new Response(html))).body;
  }
  if (byteLength(html) > MAX_RESPONSE_BYTES) {
    throw new ExtractionFailure("TOO_LARGE", "HTML source exceeds the 5 MB size limit.", 413);
  }
  let elements = 0;
  const openingTag = /<[a-z][\w:-]*(?=[\s/>])/gi;
  while (openingTag.test(html)) {
    if (++elements > 12000) throw new ExtractionFailure("TOO_LARGE", "HTML exceeds the 12,000 element limit.", 413);
  }
  const { document, title: pageTitle, author: pageAuthor, coverImage } = prepareHtmlForExtraction(html, url);
  if (byteLength(document.toString()) > MAX_SLIM_HTML_BYTES) {
    throw new Error("The page content is too large to convert after cleanup.");
  }

  ensureMarkdownDom();
  const { Defuddle } = await import("defuddle/node");
  const extracted = await Defuddle(document as never, url, {
    markdown: true,
    useAsync: false,
  });
  let markdown = extracted.content?.trim();
  if (!markdown) throw new Error("Readable content could not be identified.");
  assertReadableContent(markdown);

  const title = pageTitle || extracted.title?.trim() || titleFromMarkdown(markdown, url);
  if (markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() !== title) markdown = `# ${title}\n\n${markdown}`;
  return {
    author: pageAuthor || extracted.author?.trim() || null,
    coverImage: coverImage || publicImageUrl(extracted.image, url),
    markdown: `${markdown.trim()}\n`,
    title,
  };
}

async function readLimitedText(response: Response) {
  return readTextLimited(response, MAX_RESPONSE_BYTES);
}

async function fetchPublicPage(rawUrl: string, onTiming?: TimingObserver): Promise<SafeFetchResult> {
  let currentUrl = await measured(onTiming, "dns", () => assertPublicUrl(rawUrl));

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Source request timed out", "TimeoutError")), REQUEST_TIMEOUT_MS);
    try {
      const response = await measured(onTiming, "origin_headers", () => fetch(currentUrl, {
        headers: {
          Accept: "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.8",
          "Accept-Language": "en-US,en;q=0.8",
          "User-Agent": USER_AGENT,
        },
        redirect: "manual",
        signal: controller.signal,
      }));

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`Redirect ${response.status} had no destination.`);
        await response.body?.cancel();
        if (redirectCount === MAX_REDIRECTS) throw new Error("The URL redirected too many times.");
        currentUrl = await measured(onTiming, "dns", () => assertPublicUrl(new URL(location, currentUrl).toString()));
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new ExtractionFailure(response.status === 401 || response.status === 403 ? "BLOCKED" : "UPSTREAM_ERROR", `The website returned HTTP ${response.status}.`, 502, response.status === 429 || response.status >= 500);
      }
      const contentType = response.headers.get("content-type") || "";
      const { body, bytes } = await measured(onTiming, "origin_body", () => /text\/html|application\/xhtml\+xml/i.test(contentType)
        ? readHtmlLimited(response) : readLimitedText(response));
      return {
        body,
        contentType: response.headers.get("content-type") || "",
        finalUrl: currentUrl,
        sourceBytes: bytes,
      };
    } finally { clearTimeout(timer); }
  }
  throw new Error("The URL redirected too many times.");
}

/** Article title from a /wiki/Title path on wikipedia.org, or null. */
export function wikipediaArticleTitle(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!/(^|\.)wikipedia\.org$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/wiki\/([^/]+)$/);
    if (!match) return null;
    const title = decodeURIComponent(match[1]);
    if (!title || title === "Main_Page") return null;
    // Skip non-article namespaces (File:, Special:, etc.).
    if (/^(Special|File|Image|Media|Wikipedia|Help|Template|Category|Portal|Draft|User|Talk):/i.test(title)) {
      return null;
    }
    return title;
  } catch {
    return null;
  }
}

/**
 * MediaWiki parse HTML is article body only, but still heavy (refs, tables,
 * infoboxes). Strip non-prose bulk so Defuddle fits Worker CPU/memory.
 */
export function prepareMediaWikiHtml(fragment: string, displayTitle: string): string {
  const wrapped = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(displayTitle)}</title></head><body><article><h1>${escapeHtml(displayTitle)}</h1>${fragment}</article></body></html>`;
  const { document } = parseHTML(wrapped);

  const strip = [
    "style",
    "script",
    "link",
    "meta",
    "svg",
    "table",
    ".reference",
    "sup.reference",
    ".reflist",
    ".mw-references-wrap",
    ".navbox",
    ".vertical-navbox",
    ".sistersitebox",
    ".metadata",
    ".noprint",
    ".mw-empty-elt",
    ".mw-editsection",
    ".hatnote",
    ".shortdescription",
    ".thumb",
    ".gallery",
    ".infobox",
    "#toc",
    ".toc",
  ];
  for (const selector of strip) {
    document.querySelectorAll(selector).forEach((element: { remove(): void }) => element.remove());
  }

  // Drop appendix sections that dominate token count without helping Markdown portability.
  const dropHeading =
    /^(References|External links|Further reading|See also|Notes|Bibliography|Sources|Citations)\b/i;
  for (const heading of Array.from(document.querySelectorAll("h2, h3"))) {
    const label = (heading.textContent || "").replace(/\[edit\]/gi, "").trim();
    if (!dropHeading.test(label)) continue;
    let node: typeof heading | null = heading;
    while (node) {
      const next = node.nextElementSibling as typeof heading | null;
      node.remove();
      node = next;
      if (node && /^H[23]$/i.test(node.tagName) && !dropHeading.test((node.textContent || "").trim())) {
        break;
      }
    }
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(displayTitle)}</title></head><body>${document.body?.innerHTML || ""}</body></html>`;
}

async function extractMediaWiki(
  sourceUrl: string,
  pageTitle: string,
): Promise<Omit<StoredExtraction, "expiresAt" | "fetchedAt" | "version">> {
  const origin = new URL(sourceUrl).origin;
  // Same host as the already-validated article URL; re-check DNS for the API host.
  await assertPublicUrl(`${origin}/`);

  const apiUrl = new URL(`${origin}/w/api.php`);
  apiUrl.searchParams.set("action", "parse");
  apiUrl.searchParams.set("page", pageTitle);
  apiUrl.searchParams.set("prop", "text|displaytitle");
  apiUrl.searchParams.set("format", "json");
  apiUrl.searchParams.set("formatversion", "2");
  apiUrl.searchParams.set("redirects", "1");
  apiUrl.searchParams.set("disableeditsection", "1");
  apiUrl.searchParams.set("disablestylededuplication", "1");

  const response = await fetch(apiUrl.toString(), {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Wikipedia API returned HTTP ${response.status}.`);
  }

  const payload = JSON.parse((await readLimitedText(response)).body) as {
    error?: { info?: string };
    parse?: { title?: string; text?: string };
  };
  if (payload.error || !payload.parse?.text) {
    throw new Error(payload.error?.info || "Wikipedia API did not return article HTML.");
  }

  const displayTitle = payload.parse.title?.trim() || pageTitle.replace(/_/g, " ");
  const articleHtml = prepareMediaWikiHtml(payload.parse.text, displayTitle);
  const converted = await htmlToReadableMarkdown(articleHtml, sourceUrl);
  const finalUrl = new URL(sourceUrl);
  finalUrl.hash = "";

  return {
    author: null,
    ...(converted.coverImage ? { coverImage: converted.coverImage } : {}),
    finalUrl: finalUrl.toString(),
    markdown: converted.markdown,
    provider: "direct-html",
    sourceUrl,
    stats: {
      markdownBytes: byteLength(converted.markdown),
      sourceBytes: byteLength(payload.parse.text),
      words: countWords(converted.markdown),
    },
    title: converted.title || displayTitle,
  };
}

function extractionFromMarkdown(
  sourceUrl: string,
  finalUrl: string,
  markdown: string,
  provider: StoredExtraction["provider"],
  sourceBytes?: number,
  author: string | null = null,
  title?: string,
): Omit<StoredExtraction, "expiresAt" | "fetchedAt" | "version"> {
  const normalized = markdown.trim();
  if (!normalized) throw new Error("Empty Markdown.");
  assertReadableContent(normalized);
  const resolvedTitle = title || titleFromMarkdown(normalized, finalUrl);
  const withHeading = normalized.match(/^#\s+(.+)$/m)?.[1]?.trim() === resolvedTitle
    ? normalized : `# ${resolvedTitle}\n\n${normalized}`;
  return {
    author,
    finalUrl,
    markdown: `${withHeading.trim()}\n`,
    provider,
    sourceUrl,
    stats: {
      markdownBytes: byteLength(withHeading),
      sourceBytes,
      words: countWords(withHeading),
    },
    title: resolvedTitle,
  };
}

async function extractDirect(sourceUrl: string, onTiming?: TimingObserver): Promise<Omit<StoredExtraction, "expiresAt" | "fetchedAt" | "version">> {
  const wikiTitle = wikipediaArticleTitle(sourceUrl);
  if (wikiTitle) {
    try {
      return await extractMediaWiki(sourceUrl, wikiTitle);
    } catch {
      // Fall through to ordinary HTML fetch if the parse API fails.
    }
  }

  const fetched = await fetchPublicPage(sourceUrl, onTiming);
  const isMarkdown = /(?:text|application)\/(?:x-)?markdown/i.test(fetched.contentType);

  if (isMarkdown) {
    return extractionFromMarkdown(
      sourceUrl,
      fetched.finalUrl,
      fetched.body,
      "native-markdown",
      fetched.sourceBytes,
    );
  }

  if (!/text\/html|application\/xhtml\+xml/i.test(fetched.contentType)) {
    throw new Error(`Unsupported content type: ${fetched.contentType || "unknown"}.`);
  }

  const converted = await measured(onTiming, "parse", () => htmlToReadableMarkdown(fetched.body, fetched.finalUrl));

  return {
    author: converted.author,
    ...(converted.coverImage ? { coverImage: converted.coverImage } : {}),
    finalUrl: fetched.finalUrl,
    markdown: converted.markdown,
    provider: "direct-html",
    sourceUrl,
    stats: {
      markdownBytes: byteLength(converted.markdown),
      sourceBytes: fetched.sourceBytes,
      words: countWords(converted.markdown),
    },
    title: converted.title,
  };
}

async function browserQuickAction(
  env: ExtractionEnv,
  action: "content" | "markdown",
  sourceUrl: string,
): Promise<{ ok: boolean; result?: string }> {
  if (!env.BROWSER) return { ok: false };
  const response = await invokeBrowser(env.BROWSER, action, {
    gotoOptions: { waitUntil: "networkidle2", timeout: 20000 },
    rejectRequestPattern: ["/.*\\.(css|woff2?|ttf|png|jpe?g|gif|webp|svg)(\\?.*)?$/i"],
    url: sourceUrl,
  });
  const payload = JSON.parse((await readTextLimited(response, 6 * 1024 * 1024)).body) as { result?: string; success?: boolean };
  const result = typeof payload.result === "string" ? payload.result.trim() : "";
  if (!response.ok || payload.success === false || !result) {
    return { ok: false };
  }
  return { ok: true, result };
}

async function extractWithBrowser(
  env: ExtractionEnv,
  sourceUrl: string,
): Promise<Omit<StoredExtraction, "expiresAt" | "fetchedAt" | "version">> {
  if (!env.BROWSER || env.ENABLE_BROWSER_FALLBACK === "false") {
    throw new Error("Browser fallback is unavailable.");
  }

  // Prefer rendered HTML → slim → Defuddle over Browser's markdown QA
  // (which often returns site chrome on Wikipedia and similar shells).
  try {
    const content = await browserQuickAction(env, "content", sourceUrl);
    if (content.ok && content.result) {
      const converted = await htmlToReadableMarkdown(content.result, sourceUrl);
      return {
        author: converted.author,
        ...(converted.coverImage ? { coverImage: converted.coverImage } : {}),
        finalUrl: sourceUrl,
        markdown: converted.markdown,
        provider: "browser-run",
        sourceUrl,
        stats: {
          markdownBytes: byteLength(converted.markdown),
          sourceBytes: byteLength(content.result),
          words: countWords(converted.markdown),
        },
        title: converted.title,
      };
    }
  } catch (error) {
    // A confirmed challenge will not improve by paying for another conversion
    // of the same rendered page. Preserve allowance failures as typed failures.
    const failure = describeFailure(error);
    if (failure.code === "BLOCKED" || failure.code === "BUDGET_EXHAUSTED") throw error;
    // Fall through to markdown quick action for conversion-specific failures.
  }

  const markdownAction = await browserQuickAction(env, "markdown", sourceUrl);
  if (!markdownAction.ok || !markdownAction.result) {
    throw new Error("Browser Run could not extract Markdown from this page.");
  }
  return extractionFromMarkdown(sourceUrl, sourceUrl, markdownAction.result, "browser-run");
}

function isPolicyError(message: string) {
  return (
    /private and reserved/i.test(message) ||
    /credentials are not supported/i.test(message) ||
    /only http and https/i.test(message) ||
    /only standard web ports/i.test(message) ||
    /did not resolve to a public address/i.test(message) ||
    /enter a complete url/i.test(message)
  );
}

function combineExtractionErrors(directError: unknown, browserError: unknown) {
  const directMessage = directError instanceof Error ? directError.message : String(directError);
  const browserMessage = browserError instanceof Error ? browserError.message : String(browserError);

  // Validation/policy failures cannot be fixed by rendering the page.
  if (isPolicyError(directMessage)) return directMessage;

  if (/browser fallback is unavailable/i.test(browserMessage)) {
    return directMessage;
  }

  if (directMessage === browserMessage) return directMessage;
  return `${directMessage} Browser fallback: ${browserMessage}`;
}

export async function extractUrl(env: ExtractionEnv, sourceUrl: string, ttlSeconds: number): Promise<StoredExtraction> {
  const startedAt = new Date();
  let extracted: Omit<StoredExtraction, "expiresAt" | "fetchedAt" | "version">;

  if (isXStatusUrl(sourceUrl)) {
    extracted = await extractX(sourceUrl);
  } else {
    try {
      extracted = await extractDirect(sourceUrl, env.onTiming);
    } catch (directError) {
      const directMessage = directError instanceof Error ? directError.message : String(directError);
      if (isPolicyError(directMessage)) throw directError;
      if (env.ENABLE_BROWSER_FALLBACK === "false" || !env.BROWSER) throw directError;

      try {
        extracted = await extractWithBrowser(env, sourceUrl);
      } catch (browserError) {
        const failure = describeFailure(browserError);
        throw new ExtractionFailure(failure.code, combineExtractionErrors(directError, browserError), failure.status, false);
      }
    }
  }

  return {
    ...extracted,
    expiresAt: new Date(startedAt.getTime() + ttlSeconds * 1000).toISOString(),
    fetchedAt: startedAt.toISOString(),
    version: 1,
  };
}
