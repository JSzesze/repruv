import { describe, expect, it } from "vitest";

import {
  htmlToReadableMarkdown,
  looksLikeChromeDump,
  prepareMediaWikiHtml,
  slimHtmlForExtraction,
  wikipediaArticleTitle,
} from "../src/extract";

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

  it("slims Wikipedia-like chrome before conversion", async () => {
    const html = `<!doctype html><html><head><title>Markdown</title></head><body>
      <nav>Main menu <a href="/wiki/Main_Page">Main page</a></nav>
      <div id="mw-navigation">Jump to content</div>
      <div id="mw-content-text"><div class="mw-parser-output">
        <p><b>Markdown</b> is a lightweight markup language for creating formatted text.</p>
        <p>John Gruber created Markdown in 2004.</p>
      </div></div>
      <footer>Personal tools</footer>
    </body></html>`;

    const slim = slimHtmlForExtraction(html);
    expect(slim).not.toContain("Main menu");
    expect(slim).not.toContain("Jump to content");
    expect(slim).not.toContain("Personal tools");
    expect(slim).toContain("lightweight markup language");

    const result = await htmlToReadableMarkdown(html, "https://en.wikipedia.org/wiki/Markdown");
    expect(result.markdown).toContain("lightweight markup language");
    expect(result.markdown).toContain("John Gruber");
    expect(result.markdown).not.toMatch(/Main menu/i);
    expect(result.markdown).not.toMatch(/Jump to content/i);
  });

  it("detects chrome-dump Markdown from browser fallback", () => {
    const chrome = `[Jump to content](#bodyContent)

Main menu

Main menu

move to sidebar hide

Navigation

* [Main page](https://en.wikipedia.org/wiki/Main_Page)

# Markdown

Some real content eventually.
`;
    expect(looksLikeChromeDump(chrome)).toBe(true);
    expect(looksLikeChromeDump("# Example Domain\n\nThis domain is for documentation.\n")).toBe(false);
  });
});

describe("Wikipedia URL routing", () => {
  it("extracts article titles from wikipedia.org paths", () => {
    expect(wikipediaArticleTitle("https://en.wikipedia.org/wiki/Markdown")).toBe("Markdown");
    expect(wikipediaArticleTitle("https://en.wikipedia.org/wiki/Rust_(programming_language)")).toBe(
      "Rust_(programming_language)",
    );
    expect(wikipediaArticleTitle("https://en.wikipedia.org/wiki/Special:Random")).toBe(null);
    expect(wikipediaArticleTitle("https://example.com/wiki/Markdown")).toBe(null);
  });

  it("prepares MediaWiki parse HTML without references and tables", () => {
    const fragment = `
      <p>Rust is a language.</p>
      <table class="infobox"><tr><td>Paradigm</td></tr></table>
      <p>More prose.<sup class="reference"><a href="#cite">[1]</a></sup></p>
      <h2><span>References</span></h2>
      <ol class="references"><li>Some citation</li></ol>
      <h2><span>External links</span></h2>
      <ul><li><a href="https://example.com">site</a></li></ul>
    `;
    const prepared = prepareMediaWikiHtml(fragment, "Rust");
    expect(prepared).toContain("Rust is a language");
    expect(prepared).toContain("More prose");
    expect(prepared).not.toContain("infobox");
    expect(prepared).not.toContain("Some citation");
    expect(prepared).not.toContain("External links");
  });
});
