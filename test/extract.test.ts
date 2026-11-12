import { afterEach, describe, expect, it, vi } from "vitest";
import { extractUrl } from "../src/extract";

// DNS remains real for public example.com; all page/provider fetches are mocked.
// Pin DNS too so these regression checks do not require network access.
vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(async () => ["93.184.216.34"]),
  resolve6: vi.fn(async () => []),
}));

afterEach(() => vi.unstubAllGlobals());

describe("extraction fallback", () => {
  const sourceUrl = "https://example.com/article";
  const challenge = "# example.com\n\n## Performing security verification\n\nVerifying you are not a bot.";

  it("rejects native Markdown challenges", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(challenge, {
      headers: { "content-type": "text/markdown" },
    })));
    await expect(extractUrl({ ENABLE_BROWSER_FALLBACK: "false" }, sourceUrl, 3600))
      .rejects.toThrow("security verification");
  });

  it("does not turn browser-rendered challenges into successful cache entries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Forbidden", { status: 403 })));
    const quickAction = vi.fn(async (action: string) => new Response(JSON.stringify({
      success: true,
      result: action === "content"
        ? "<html><body><h2>Performing security verification</h2></body></html>" : challenge,
    })));
    await expect(extractUrl({ BROWSER: { quickAction } }, sourceUrl, 3600))
      .rejects.toThrow("security verification");
    expect(quickAction.mock.calls.map(([action]) => action)).toEqual(["content"]);
  });

  it("uses browser HTML after a direct challenge and keeps the correct metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(challenge, {
      headers: { "content-type": "text/markdown" },
    })));
    const quickAction = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: '<html><head><title>Readable Article</title></head><body><article><h1>Readable Article</h1><p>A useful paragraph with enough context to represent the readable article body.</p></article></body></html>',
    })));
    const result = await extractUrl({ BROWSER: { quickAction } }, sourceUrl, 3600);
    expect(result).toMatchObject({ title: "Readable Article", provider: "browser-run" });
    expect(result.markdown).toContain("A useful paragraph");
    expect(quickAction).toHaveBeenCalledTimes(1);
  });
});
