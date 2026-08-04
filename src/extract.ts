import { DOMParser, parseHTML } from "linkedom";

import type { Env, StoredExtraction } from "./types";
import { assertPublicUrl, isXStatusUrl } from "./url";
import { extractX } from "./x";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Cap post-slim HTML so linkedom + Defuddle stay within Worker limits. */
const MAX_SLIM_HTML_BYTES = 900 * 1024;
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
  "header",
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
  const scope = globalThis as typeof globalThis & {
    DOMParser?: unknown;
    document?: unknown;
    window?: unknown;
  };
  const compatibilityDom = parseHTML("<!doctype html><html><body></body></html>");
  if (!scope.document) scope.document = compatibilityDom.document;
  if (!scope.window) scope.window = compatibilityDom.window;
  if (!scope.DOMParser) scope.DOMParser = DOMParser;
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
export function slimHtmlForExtraction(html: string): string {
  const { document } = parseHTML(html);

  for (const selector of REMOVE_SELECTORS) {
    document.querySelectorAll(selector).forEach((element: { remove(): void }) => element.remove());
  }

  const title =
    document.querySelector("h1")?.textContent?.trim() ||
    document.querySelector("title")?.textContent?.trim() ||
    "";

  let root: { outerHTML: string; innerHTML: string; tagName: string; textContent: string | null } | null =
    null;
  for (const selector of CONTENT_SELECTORS) {
    const candidate = document.querySelector(selector);
    if (candidate && (candidate.textContent?.trim().length || 0) > 80) {
      root = candidate;
      break;
    }
  }
  if (!root) root = document.body;
  if (!root) return html;

  const body =
    root.tagName.toLowerCase() === "body" ? root.innerHTML : root.outerHTML;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

export function looksLikeChromeDump(markdown: string): boolean {
  const head = markdown.slice(0, 2_000);
  const hits = CHROME_MARKDOWN_SIGNALS.filter((pattern) => pattern.test(head)).length;
  // Two+ chrome phrases near the top = site chrome, not the article.
  return hits >= 2;
}

export async function htmlToReadableMarkdown(html: string, url: string) {
  const slim = slimHtmlForExtraction(html);
  if (byteLength(slim) > MAX_SLIM_HTML_BYTES) {
    throw new Error("The page content is too large to convert after cleanup.");
  }

  const { document } = parseHTML(slim);
  ensureMarkdownDom();
  const { Defuddle } = await import("defuddle/node");
  const extracted = await Defuddle(document as never, url, {
    markdown: true,
    useAsync: false,
  });
  let markdown = extracted.content?.trim();
  if (!markdown) throw new Error("Readable content could not be identified.");
  if (looksLikeChromeDump(markdown)) {
    throw new Error("Readable content could not be isolated from page chrome.");
  }

  const title = extracted.title?.trim() || titleFromMarkdown(markdown, url);
  if (!/^#\s+\S/m.test(markdown)) markdown = `# ${title}\n\n${markdown}`;
  return {
    author: extracted.author?.trim() || null,
    markdown: `${markdown.trim()}\n`,
    title,
  };
}

async function readLimitedText(response: Response) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("The page is larger than the 5 MB service limit.");
  }
  if (!response.body) return { body: "", bytes: 0 };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("The page is larger than the 5 MB service limit.");
    }
    body += decoder.decode(value, { stream: true });
  }
  return { body: body + decoder.decode(), bytes };
}

async function fetchPublicPage(rawUrl: string): Promise<SafeFetchResult> {
  let currentUrl = await assertPublicUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      headers: {
        Accept: "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.8",
        "Accept-Language": "en-US,en;q=0.8",
        "User-Agent": USER_AGENT,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect ${response.status} had no destination.`);
      if (redirectCount === MAX_REDIRECTS) throw new Error("The URL redirected too many times.");
      currentUrl = await assertPublicUrl(new URL(location, currentUrl).toString());
      continue;
    }

    const { body, bytes } = await readLimitedText(response);
    if (!response.ok) {
      throw new Error(`The website returned HTTP ${response.status}.`);
    }
    return {
      body,
      contentType: response.headers.get("content-type") || "",
      finalUrl: currentUrl,
      sourceBytes: bytes,
    };
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
  for (const heading of [...document.querySelectorAll("h2, h3")]) {
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
    throw new Error(`Wikipedia API returned HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as {
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
  if (looksLikeChromeDump(normalized)) {
    throw new Error("Extraction returned page chrome instead of article content.");
  }
  const resolvedTitle = title || titleFromMarkdown(normalized, finalUrl);
  const withHeading = /^#\s+\S/m.test(normalized) ? normalized : `# ${resolvedTitle}\n\n${normalized}`;
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

async function extractDirect(sourceUrl: string): Promise<Omit<StoredExtraction, "expiresAt" | "fetchedAt" | "version">> {
  const wikiTitle = wikipediaArticleTitle(sourceUrl);
  if (wikiTitle) {
    try {
      return await extractMediaWiki(sourceUrl, wikiTitle);
    } catch {
      // Fall through to ordinary HTML fetch if the parse API fails.
    }
  }

  const fetched = await fetchPublicPage(sourceUrl);
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

  const converted = await htmlToReadableMarkdown(fetched.body, fetched.finalUrl);

  return {
    author: converted.author,
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
  env: Env,
  action: "content" | "markdown",
  sourceUrl: string,
): Promise<{ ok: boolean; result?: string }> {
  if (!env.BROWSER) return { ok: false };
  const response = await env.BROWSER.quickAction(action, {
    gotoOptions: { waitUntil: "networkidle2" },
    rejectRequestPattern: ["/.*\\.(css|woff2?|ttf|png|jpe?g|gif|webp|svg)(\\?.*)?$/i"],
    url: sourceUrl,
  });
  const payload = (await response.json()) as { result?: string; success?: boolean };
  const result = typeof payload.result === "string" ? payload.result.trim() : "";
  if (!response.ok || payload.success === false || !result) {
    return { ok: false };
  }
  return { ok: true, result };
}

async function extractWithBrowser(
  env: Env,
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
  } catch {
    // Fall through to markdown quick action.
  }

  const markdownAction = await browserQuickAction(env, "markdown", sourceUrl);
  if (!markdownAction.ok || !markdownAction.result) {
    throw new Error("Browser Run could not extract Markdown from this page.");
  }
  if (looksLikeChromeDump(markdownAction.result)) {
    throw new Error("Browser extraction returned page chrome instead of article content.");
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

export async function extractUrl(env: Env, sourceUrl: string, ttlSeconds: number): Promise<StoredExtraction> {
  const startedAt = new Date();
  let extracted: Omit<StoredExtraction, "expiresAt" | "fetchedAt" | "version">;

  if (isXStatusUrl(sourceUrl)) {
    extracted = await extractX(sourceUrl);
  } else {
    try {
      extracted = await extractDirect(sourceUrl);
    } catch (directError) {
      const directMessage = directError instanceof Error ? directError.message : String(directError);
      if (isPolicyError(directMessage)) throw directError;

      try {
        extracted = await extractWithBrowser(env, sourceUrl);
      } catch (browserError) {
        throw new Error(combineExtractionErrors(directError, browserError));
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
