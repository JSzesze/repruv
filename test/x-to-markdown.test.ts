import { describe, expect, it } from "vitest";

import { convertFxTwitterPayload, parseXStatusUrl } from "../src/x-to-markdown";

describe("X conversion", () => {
  it("parses post URLs", () => {
    expect(parseXStatusUrl("https://x.com/example/status/123")).toEqual({
      id: "123",
      username: "example",
    });
  });

  it("converts a basic post", () => {
    const result = convertFxTwitterPayload({
      tweet: {
        author: { name: "Example Person", screen_name: "example" },
        text: "A useful post.",
      },
    });
    expect(result.title).toBe("Post by @example");
    expect(result.markdown).toContain("A useful post.");
    expect(result.author).toBe("Example Person (@example)");
  });
});
