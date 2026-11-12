import { afterEach, describe, expect, it, vi } from "vitest";
import { extractViaConvex } from "../src/convex-extraction";
import { relayBrowserRequest } from "../src/browser-relay";
import { verifyProxySecret } from "../src/proxy-auth";

vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(async () => ["93.184.216.34"]), resolve6: vi.fn(async () => []),
}));
afterEach(() => vi.unstubAllGlobals());

describe("private Convex extraction bridge", () => {
  it("authenticates matching secrets and rejects missing or incorrect ones", async () => {
    expect(await verifyProxySecret("test-shared-secret", "test-shared-secret")).toBe(true);
    expect(await verifyProxySecret("different-secret", "test-shared-secret")).toBe(false);
    expect(await verifyProxySecret(null, "test-shared-secret")).toBe(false);
    expect(await verifyProxySecret("test-shared-secret", undefined)).toBe(false);
  });

  it("sends extraction to Convex with the shared secret and preserves the result", async () => {
    const result = { version: 1, markdown: "# Article\n\nBody.", stats: { words: 2 } };
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(result));
    vi.stubGlobal("fetch", fetchMock);
    expect(await extractViaConvex("https://repruv-example.convex.site", "test-shared-secret", "https://example.com/article", 3600)).toEqual(result);
    const [request, init] = fetchMock.mock.calls[0];
    expect(String(request)).toBe("https://repruv-example.convex.site/internal/extract");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-shared-secret" });
    expect(JSON.parse(init?.body as string)).toEqual({ url: "https://example.com/article", ttlSeconds: 3600 });
  });

  it("propagates extraction failures and rejects malformed successful responses", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { message: "Security verification required." } }, { status: 502 }))
      .mockResolvedValueOnce(Response.json({ version: 1, markdown: "" })));
    await expect(extractViaConvex("https://repruv-example.convex.site", "test-shared-secret", "https://example.com", 3600)).rejects.toThrow("Security verification required");
    await expect(extractViaConvex("https://repruv-example.convex.site", "test-shared-secret", "https://example.com", 3600)).rejects.toThrow("invalid result");
  });

  it("reports a non-JSON gateway failure with its HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("error code: 502", { status: 502 })));
    await expect(extractViaConvex("https://repruv-example.convex.site", "test-shared-secret", "https://example.com", 3600))
      .rejects.toThrow("HTTP 502 without a JSON result");
  });
});

describe("private browser relay", () => {
  function setup() {
    const quickAction = vi.fn(async (_action: "content" | "markdown", _input: Record<string, unknown>) => Response.json({ success: true, result: "<html>Rendered page</html>" }));
    const ledger = { reserve: vi.fn(async () => "test-lease"), release: vi.fn(async () => {}) };
    return { quickAction, env: { BROWSER: { quickAction }, REPRUV_PROXY_SECRET: "test-shared-secret", FALLBACK_BUDGET: { getByName: () => ledger } } };
  }
  function request(input: unknown, token = "test-shared-secret") {
    return new Request("https://repruv.com/api/internal/browser", {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(input),
    });
  }

  it("does not render anything for unauthorized callers", async () => {
    const { env, quickAction } = setup();
    expect((await relayBrowserRequest(request({ action: "content", url: "https://example.com" }, "wrong-secret"), env)).status).toBe(401);
    expect(quickAction).not.toHaveBeenCalled();
  });

  it("only renders public URLs with supported actions and controlled options", async () => {
    const { env, quickAction } = setup();
    expect((await relayBrowserRequest(request({ action: "content", url: "http://127.0.0.1/private" }), env)).status).toBe(400);
    expect((await relayBrowserRequest(request({ action: "screenshot", url: "https://example.com" }), env)).status).toBe(400);
    expect(quickAction).not.toHaveBeenCalled();
    expect((await relayBrowserRequest(request({ action: "content", url: "https://example.com/article", cookies: ["ignored"] }), env)).status).toBe(200);
    expect(quickAction).toHaveBeenCalledWith("content", expect.objectContaining({ url: "https://example.com/article" }));
    expect(quickAction.mock.calls[0][1]).not.toHaveProperty("cookies");
  });
});
