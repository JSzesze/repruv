import type { Env, StoredExtraction } from "./types";

export interface CachedValue {
  key: string;
  result: StoredExtraction;
  stale: boolean;
}

export async function readCachedResult(env: Env, key: string): Promise<CachedValue | null> {
  const object = await env.RESULTS.get(key);
  if (!object) return null;

  try {
    const result = JSON.parse(await object.text()) as StoredExtraction;
    if (result.version !== 1 || typeof result.markdown !== "string") return null;
    return {
      key,
      result,
      stale: Date.parse(result.expiresAt) <= Date.now(),
    };
  } catch {
    return null;
  }
}

export async function writeCachedResult(
  env: Env,
  key: string,
  result: StoredExtraction,
) {
  await env.RESULTS.put(key, JSON.stringify(result), {
    customMetadata: {
      expiresAt: result.expiresAt,
      sourceUrl: result.sourceUrl.slice(0, 1024),
      version: String(result.version),
    },
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

export function resultAgeSeconds(result: StoredExtraction) {
  return Math.max(0, Math.floor((Date.now() - Date.parse(result.fetchedAt)) / 1000));
}
