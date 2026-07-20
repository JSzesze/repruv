import { describe, expect, it } from "vitest";

import { htmlToReadableMarkdown } from "../src/extract";

describe("HTML extraction", () => {
  it("produces clean Markdown without Defuddle's partial-conversion fallback", async () => {
    const result = await htmlToReadableMarkdown(
      `<!doctype html><html><head><title>Small Article</title></head><body><main><h1>Small Article</h1><p>A useful paragraph with a <a href="https://example.com/more">link</a>.</p></main></body></html>`,
      "https://example.com/article",
    );

    expect(result.title).toBe("Small Article");
    expect(result.markdown).toContain("A useful paragraph");
    expect(result.markdown).toContain("[link](https://example.com/more)");
    expect(result.markdown).not.toContain("Partial conversion completed with errors");
    expect(result.markdown).not.toContain("<body>");
  });
});
