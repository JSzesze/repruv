import { v } from "convex/values";

export const extractionResult = v.object({
  author: v.union(v.string(), v.null()),
  expiresAt: v.string(),
  fetchedAt: v.string(),
  finalUrl: v.string(),
  markdown: v.string(),
  provider: v.union(v.literal("browser-run"), v.literal("direct-html"), v.literal("native-markdown"), v.literal("x-fxtwitter"), v.literal("firecrawl")),
  sourceUrl: v.string(),
  stats: v.object({ markdownBytes: v.number(), sourceBytes: v.optional(v.number()), words: v.number() }),
  title: v.string(),
  version: v.literal(1),
  contentStatus: v.optional(v.union(v.literal("article"), v.literal("preview"))),
  extractorVersion: v.optional(v.string()),
});
