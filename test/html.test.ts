import { describe, expect, it } from "vitest";

import {
  htmlToReadableMarkdown,
  looksLikeChromeDump,
  looksLikeChallengePage,
  prepareMediaWikiHtml,
  slimHtmlForExtraction,
  wikipediaArticleTitle,
} from "../src/extract";

describe("HTML extraction", () => {
  it("keeps the article title and author when a body H1 differs from its header", async () => {
    const result = await htmlToReadableMarkdown(`<!doctype html><html><head>
      <title>The useful search engine - DEV Community</title>
      <meta property="og:title" content="The useful search engine">
      <meta name="author" content="Ben Example">
      </head><body><header class="site-header">Site navigation</header>
      <article><header><h1>The useful search engine</h1></header>
      <div class="article-body"><p>Our community search helps people find useful explanations and ask questions.</p>
      <h1>Google</h1><p>This heading compares search providers, and must not become the article title.</p></div>
      </article></body></html>`, "https://dev.to/example/search");
    expect(result.title).toBe("The useful search engine");
    expect(result.markdown).toMatch(/^# The useful search engine\n/);
    expect(result.author).toBe("Ben Example");
    expect(result.markdown).toContain("Our community search");
    expect(result.markdown).not.toContain("Site navigation");
  });

  it("preserves article headers with introductory content", async () => {
    const result = await htmlToReadableMarkdown(`<!doctype html><html><head><title>A useful article</title></head>
      <body><article><header><h1>A useful article</h1><p>An introduction belongs to the article.</p></header>
      <p>The main body contains a longer explanation that is useful to readers and should remain in the output.</p>
      </article></body></html>`, "https://example.com/article");
    expect(result.markdown).toContain("An introduction belongs to the article.");
  });

  it.each([
    '<html><head><title>Just a moment...</title></head><body><p>Checking your browser</p></body></html>',
    '<html><body><h2>Performing security verification</h2><p>Verifying you are not a bot.</p></body></html>',
    '<html><body><form id="challenge-form">Please wait.</form></body></html>',
  ])("rejects a security page before extracting it", async html => {
    await expect(htmlToReadableMarkdown(html, "https://example.com/article")).rejects.toThrow("security verification");
  });

  it("recognizes Markdown challenges without rejecting prose about bot protection", () => {
    expect(looksLikeChallengePage("# medium.com\n\n## Performing security verification\n\nPlease wait.")).toBe(true);
    expect(looksLikeChallengePage("# Browser security explained\n\nThe screen says Just a moment while checking your browser.")).toBe(false);
  });

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

describe("article images", () => {
  const body = '<p>A useful opening paragraph gives the reader enough context to keep this article selected.</p><p>The article continues with a substantial explanation and useful details about the subject.</p>';
  it("preserves a lead image stored above the article body, without adding author avatars", async () => {
    const result = await htmlToReadableMarkdown(`<html><head><title>Article with artwork</title>
      <meta property="og:image" content="/photos/lead.jpg?quality=90&amp;w=1200">
      </head><body><header class="site-header"><img src="https://example.com/logo.png"></header>
      <article><header><h1>Article with artwork</h1><aside><img src="/author-avatar.jpg"></aside>
      <div style="position:relative"><img style="position:absolute" src="/photos/lead.jpg?w=2400"></div></header>
      <div class="article-body">${body}</div></article></body></html>`, "https://example.com/story");
    expect(result.coverImage).toBe("https://example.com/photos/lead.jpg?quality=90&w=1200");
    expect(result.markdown).toContain("A useful opening paragraph");
    expect(result.markdown).not.toContain("author-avatar");
    expect(result.markdown).not.toContain("logo.png");
  });
  it("retains inline article figures and their captions", async () => {
    const result = await htmlToReadableMarkdown(`<html><head><title>An illustrated explanation</title></head><body><article>
      <h1>An illustrated explanation</h1>${body}<figure><img width="1000" height="600" src="https://images.example.com/diagram.jpg" alt="Architecture diagram">
      <figcaption>The diagram explains the connections.</figcaption></figure>${body}</article></body></html>`, "https://example.com/story");
    expect(result.markdown).toContain("![Architecture diagram](https://images.example.com/diagram.jpg)");
    expect(result.markdown).toContain("The diagram explains the connections.");
  });
  it.each(["data:image/png;base64,AAAA", "javascript:alert(1)", "http://127.0.0.1/private", "https://user:secret@example.com/photo.jpg"])("rejects unsafe cover metadata: %s", async cover => {
    const result = await htmlToReadableMarkdown(`<html><head><title>A useful article</title><meta property="og:image" content="${cover}"></head><body><article><h1>A useful article</h1>${body}</article></body></html>`, "https://example.com/story");
    expect(result.coverImage).toBeUndefined();
  });
});
