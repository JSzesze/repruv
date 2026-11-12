export type ExtractionProvider =
  | "browser-run"
  | "direct-html"
  | "native-markdown"
  | "firecrawl"
  | "x-fxtwitter";

export interface ExtractionStats {
  markdownBytes: number;
  sourceBytes?: number;
  words: number;
}

export interface StoredExtraction {
  author: string | null;
  expiresAt: string;
  fetchedAt: string;
  finalUrl: string;
  markdown: string;
  provider: ExtractionProvider;
  sourceUrl: string;
  stats: ExtractionStats;
  title: string;
  version: 1;
  contentStatus?: "article" | "preview";
  extractorVersion?: string;
}

export interface ExtractionResponse extends StoredExtraction {
  cache: {
    ageSeconds: number;
    key: string;
    status: "HIT" | "MISS" | "STALE";
  };
}

export type BrowserInput = { url: string; gotoOptions?: { waitUntil: "networkidle2"; timeout?: number }; rejectRequestPattern?: string[] };
export interface BrowserRunBinding {
  quickAction(action: "content", input: BrowserInput): Promise<Response>;
  quickAction(action: "markdown", input: BrowserInput): Promise<Response>;
}

export function invokeBrowser(browser: BrowserRunBinding, action: "content" | "markdown", input: BrowserInput): Promise<Response> {
  return action === "content" ? browser.quickAction("content", input) : browser.quickAction("markdown", input);
}

export interface ExtractionEnv {
  BROWSER?: BrowserRunBinding;
  ENABLE_BROWSER_FALLBACK?: string;
  onTiming?: import("./timing").TimingObserver;
}
