import type { StoredExtraction } from "./types";
import { convertFxTwitterPayload, parseXStatusUrl } from "./x-to-markdown";

const REQUEST_TIMEOUT_MS = 15_000;

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function countWords(markdown: string) {
  return markdown
    .replace(/\[[^\]]+\]\([^)]*\)/g, " ")
    .replace(/[#>*_`|~-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export async function extractX(
  sourceUrl: string,
): Promise<Omit<StoredExtraction, "expiresAt" | "fetchedAt" | "version">> {
  const { id, username } = parseXStatusUrl(sourceUrl);
  const upstreamUrl = `https://api.fxtwitter.com/${encodeURIComponent(username)}/status/${id}`;
  const response = await fetch(upstreamUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "URLToMarkdown/0.1 (+https://github.com/JSzesze)",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const rawText = await response.text();

  let payload: unknown;
  try {
    payload = JSON.parse(rawText);
  } catch {
    throw new Error(`The X provider returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(`The X provider returned HTTP ${response.status}.`);
  }

  const converted = convertFxTwitterPayload(payload);
  return {
    author: converted.author,
    finalUrl: sourceUrl,
    markdown: converted.markdown,
    provider: "x-fxtwitter",
    sourceUrl,
    stats: {
      markdownBytes: byteLength(converted.markdown),
      sourceBytes: byteLength(rawText),
      words: countWords(converted.markdown),
    },
    title: converted.title,
  };
}
