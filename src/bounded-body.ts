import { ExtractionFailure } from "./failures";

export async function readTextLimited(response: Response, maxBytes: number): Promise<{ body: string; bytes: number }> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new ExtractionFailure("TOO_LARGE", "Response exceeds the size limit.", 413);
  }
  if (!response.body) return { body: "", bytes: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new ExtractionFailure("TOO_LARGE", "Response exceeds the size limit.", 413);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return { body: parts.join(""), bytes };
  } finally { reader.releaseLock(); }
}

/** Remove non-content before building a JavaScript DOM in the Workers isolate. */
export async function readHtmlLimited(response: Response): Promise<{ body: string; bytes: number }> {
  const maxSource = 5 * 1024 * 1024;
  const maxCleaned = 512 * 1024;
  if (typeof HTMLRewriter === "undefined") return readTextLimited(response, maxSource);
  if (Number(response.headers.get("content-length") || 0) > maxSource) {
    await response.body?.cancel();
    throw new ExtractionFailure("TOO_LARGE", "HTML source exceeds the 5 MB size limit.", 413);
  }
  let sourceBytes = 0;
  const limited = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sourceBytes += chunk.byteLength;
      if (sourceBytes > maxSource) throw new ExtractionFailure("TOO_LARGE", "HTML source exceeds the 5 MB size limit.", 413);
      controller.enqueue(chunk);
    },
  }));
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const rewriter = new HTMLRewriter();
  for (const selector of ["script", "style", "noscript", "template", "iframe", "svg",
    "nav", "footer", "form", ".sidebar", "#sidebar", ".site-header", ".site-footer", ".cookie-banner",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']"]) {
    rewriter.on(selector, { element(element) { element.remove(); } });
  }
  rewriter.onDocument({ comments(comment) { comment.remove(); } });
  const { body } = await readTextLimited(rewriter.transform(new Response(limited, { headers })), maxCleaned);
  return { body, bytes: sourceBytes };
}
