import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractUrl } from "../src/extract";

// Opt-in sampling of the pages that exposed regressions. Raw HTML is never
// committed; complete generated results remain under ignored .test-output/.
describe.skipIf(process.env.REPRUV_LIVE !== "1")("live Node extraction", () => {
  it.each([
    ["blog", "https://www.paulgraham.com/worked.html", "What I Worked On"],
    ["dev", "https://dev.to/ben/the-devto-search-engine-is-actually-pretty-damn-useful-1ic", "The dev.to search engine"],
    ["newsletter", "https://www.oneusefulthing.org/p/centaurs-and-cyborgs-on-the-jagged", "Centaurs and Cyborgs"],
    ["wikipedia", "https://en.wikipedia.org/wiki/Markdown", "Markdown"],
    ["github", "https://github.com/cli/cli", "GitHub"],
    ["bibleproject", "https://bibleproject.com/guides/book-of-genesis/", "Book of Genesis"],
  ])("extracts %s", async (id, url, title) => {
    const started = performance.now();
    const result = await extractUrl({ ENABLE_BROWSER_FALLBACK: "false" }, url, 3600);
    await mkdir(".test-output/live", { recursive: true });
    await writeFile(`.test-output/live/${id}.json`, JSON.stringify({ ...result, durationMs: Math.round(performance.now() - started) }, null, 2));
    await writeFile(`.test-output/live/${id}.md`, result.markdown);
    expect(result.title).toContain(title);
    expect(result.stats.words).toBeGreaterThan(100);
    expect(result.markdown).not.toContain("Performing security verification");
    if (id === "github") {
      expect(result.markdown).toContain("## Installation");
      expect(result.markdown).toContain("## Comparison with hub");
      expect(result.markdown).toContain("```");
    }
    if (id === "bibleproject") {
      expect(result.markdown).toContain("The Big Idea");
      expect(result.markdown).toContain("What is the significance of the 7 days of creation?");
      expect(result.markdown).toContain("a sense of wholeness or completion");
      expect(result.markdown).toContain("Do I start the Bible at Genesis?");
      expect(result.markdown).toContain("more than welcome to start reading");
    }
    console.log(JSON.stringify({ sample: id, title: result.title, words: result.stats.words, durationMs: Math.round(performance.now() - started) }));
  }, 60_000);
});
