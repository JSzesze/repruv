import { describe, expect, it } from "vitest";

import { cacheKeyForUrl, isPrivateAddress, isXStatusUrl, normalizeUrl } from "../src/url";

describe("normalizeUrl", () => {
  it("removes fragments and normalizes the host", () => {
    expect(normalizeUrl("https://EXAMPLE.com/article?q=1#comments")).toBe(
      "https://example.com/article?q=1",
    );
  });

  it.each([
    "http://localhost/test",
    "http://127.0.0.1/test",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.4/test",
    "file:///tmp/example",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => normalizeUrl(url)).toThrow();
  });
});

describe("address checks", () => {
  it("distinguishes public and private addresses", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("source routing", () => {
  it("recognizes X and Twitter post URLs", () => {
    expect(isXStatusUrl("https://x.com/user/status/123456")).toBe(true);
    expect(isXStatusUrl("https://twitter.com/user/status/123456")).toBe(true);
    expect(isXStatusUrl("https://example.com/user/status/123456")).toBe(false);
  });

  it("creates stable, distinct cache keys", async () => {
    const first = await cacheKeyForUrl("https://example.com/one");
    expect(first).toBe(await cacheKeyForUrl("https://example.com/one"));
    expect(first).not.toBe(await cacheKeyForUrl("https://example.com/two"));
  });
});
