import type { StoredExtraction } from "./types";
import { ExtractionFailure } from "./failures";
import { looksLikeChallengePage, looksLikeChromeDump } from "./extract";

export function isStoredExtraction(value: unknown): value is StoredExtraction {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<StoredExtraction>;
  return result.version === 1 && typeof result.markdown === "string" && !!result.markdown.trim()
    && typeof result.title === "string" && !!result.title.trim()
    && (result.author === null || typeof result.author === "string")
    && typeof result.sourceUrl === "string" && typeof result.finalUrl === "string"
    && ["direct-html", "native-markdown", "browser-run", "x-fxtwitter", "firecrawl"].includes(result.provider || "")
    && Number.isFinite(Date.parse(result.expiresAt || "")) && Number.isFinite(Date.parse(result.fetchedAt || ""))
    && !!result.stats && Number.isFinite(result.stats.words) && result.stats.words >= 0
    && Number.isFinite(result.stats.markdownBytes) && result.stats.markdownBytes >= 0;
}

export function normalizeExtraction(result: StoredExtraction): StoredExtraction {
  const markdown = result.markdown.replace(/\r\n?/g, "\n").trim();
  if (!markdown) throw new ExtractionFailure("NO_CONTENT", "No readable article content was returned.");
  if (looksLikeChallengePage(markdown)) throw new ExtractionFailure("BLOCKED", "The website returned a security verification page.");
  if (result.provider !== "x-fxtwitter" && looksLikeChromeDump(markdown)) throw new ExtractionFailure("NO_CONTENT", "Extraction returned site navigation instead of article content.");
  if (new TextEncoder().encode(markdown).byteLength > 1024 * 1024) throw new ExtractionFailure("TOO_LARGE", "Article exceeds the 1 MB Markdown limit.", 413);
  const preview = /(?:this (?:post|article) is for paid subscribers|subscribe to (?:continue reading|read (?:the )?(?:full|rest))|continue reading (?:with|by purchasing) a subscription|member-only (?:story|content))/i.test(markdown);
  return {
    ...result,
    markdown: `${markdown}\n`,
    contentStatus: preview ? "preview" : "article",
    extractorVersion: "2026-11-11.3",
    stats: {
      ...result.stats,
      markdownBytes: new TextEncoder().encode(`${markdown}\n`).byteLength,
      words: markdown.replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[#>*_`|~-]/g, " ").trim().split(/\s+/).filter(Boolean).length,
    },
  };
}
