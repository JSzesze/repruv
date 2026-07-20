import { DOMParser, parseHTML } from "linkedom";

import type { Env, StoredExtraction } from "./types";
import { assertPublicUrl, isXStatusUrl } from "./url";
import { extractX } from "./x";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

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

export async function htmlToReadableMarkdown(html: string, url: string) {
  const { document } = parseHTML(html);
  ensureMarkdownDom();
  const { Defuddle } = await import("defuddle/node");
  const extracted = await Defuddle(document as never, url, {
    markdown: true,
    useAsync: false,
  });
  let markdown = extracted.content?.trim();
  if (!markdown) throw new Error("Readable content could not be identified.");

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
        "User-Agent": "URLToMarkdown/0.1 (+https://github.com/JSzesze)",
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

async function extractDirect(sourceUrl: string): Promise<Omit<StoredExtraction, "expiresAt" | "fetchedAt" | "version">> {
  const fetched = await fetchPublicPage(sourceUrl);
  const isMarkdown = /(?:text|application)\/(?:x-)?markdown/i.test(fetched.contentType);

  if (isMarkdown) {
    const markdown = fetched.body.trim();
    if (!markdown) throw new Error("The website returned empty Markdown.");
    return {
      author: null,
      finalUrl: fetched.finalUrl,
      markdown: `${markdown}\n`,
      provider: "native-markdown",
      sourceUrl,
      stats: {
        markdownBytes: byteLength(markdown),
        sourceBytes: fetched.sourceBytes,
        words: countWords(markdown),
      },
      title: titleFromMarkdown(markdown, fetched.finalUrl),
    };
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

async function extractWithBrowser(
  env: Env,
  sourceUrl: string,
): Promise<Omit<StoredExtraction, "expiresAt" | "fetchedAt" | "version">> {
  if (!env.BROWSER || env.ENABLE_BROWSER_FALLBACK === "false") {
    throw new Error("Browser fallback is unavailable.");
  }

  const response = await env.BROWSER.quickAction("markdown", {
    gotoOptions: { waitUntil: "networkidle2" },
    rejectRequestPattern: ["/.*\\.(css|woff2?|ttf)(\\?.*)?$/i"],
    url: sourceUrl,
  });
  const payload = (await response.json()) as { result?: string; success?: boolean };
  const markdown = payload.result?.trim();
  if (!response.ok || !payload.success || !markdown) {
    throw new Error("Browser Run could not extract Markdown from this page.");
  }
  const finalUrl = sourceUrl;
  return {
    author: null,
    finalUrl,
    markdown: `${markdown}\n`,
    provider: "browser-run",
    sourceUrl,
    stats: {
      markdownBytes: byteLength(markdown),
      words: countWords(markdown),
    },
    title: titleFromMarkdown(markdown, finalUrl),
  };
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
      try {
        extracted = await extractWithBrowser(env, sourceUrl);
      } catch (browserError) {
        const directMessage = directError instanceof Error ? directError.message : String(directError);
        const browserMessage = browserError instanceof Error ? browserError.message : String(browserError);
        throw new Error(`${directMessage} Browser fallback: ${browserMessage}`);
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
