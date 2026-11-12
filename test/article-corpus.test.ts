import { describe, expect, it } from "vitest";
import cases from "../fixtures/articles/cases.json";
import { htmlToReadableMarkdown } from "../src/extract";
import { normalizeExtraction } from "../src/result-contract";

describe.each(cases)("article corpus: $id", fixture => {
  it("preserves the expected content and common result contract", async () => {
    const escapedTitle = fixture.title.replace(/&/g, "&amp;");
    const html = `<!doctype html><html><head><title>${escapedTitle}</title><meta property="og:title" content="${escapedTitle}"><meta name="author" content="Fixture Author"></head><body><nav>Unrelated navigation</nav><article><header><h1>${escapedTitle}</h1></header>${fixture.body}</article><aside>Unrelated comments</aside><footer>Site footer</footer></body></html>`;
    const converted = await htmlToReadableMarkdown(html, "https://example.com/article");
    const result = normalizeExtraction({ ...converted, sourceUrl: "https://example.com/article", finalUrl: "https://example.com/article", fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), provider: "direct-html", version: 1, stats: { words: 0, markdownBytes: 0 } });
    expect(result.title).toBe(fixture.title);
    expect(result.author).toBe("Fixture Author");
    for (const text of fixture.contains) expect(result.markdown).toContain(text);
    expect(result.markdown).not.toContain("Unrelated navigation");
    expect(result.markdown).not.toContain("Unrelated comments");
    expect(result.markdown).not.toContain("Unrelated hidden promotion");
    expect(result.contentStatus).toBe(fixture.contentStatus || "article");
    expect(result.markdown.endsWith("\n")).toBe(true);
  });
});
