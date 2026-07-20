import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOST_SUFFIXES = [".internal", ".local", ".localhost"];

function isPrivateIpv4(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) {
    return true;
  }

  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string) {
  const normalized = address.toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPrivateIpv4(mapped);

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("2001:db8:")
  );
}

export function isPrivateAddress(address: string) {
  const kind = isIP(address);
  if (kind === 4) return isPrivateIpv4(address);
  if (kind === 6) return isPrivateIpv6(address);
  return true;
}

export function normalizeUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("Enter a complete URL, including https:// or http://.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not supported.");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new Error("Only standard web ports are supported.");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    (isIP(hostname) > 0 && isPrivateAddress(hostname))
  ) {
    throw new Error("Private and reserved network URLs are not supported.");
  }

  url.hash = "";
  url.hostname = hostname;
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  return url.toString();
}

export async function assertPublicUrl(rawUrl: string) {
  const normalized = normalizeUrl(rawUrl);
  const url = new URL(normalized);
  if (isIP(url.hostname)) return normalized;

  const settled = await Promise.allSettled([resolve4(url.hostname), resolve6(url.hostname)]);
  const addresses = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (addresses.length === 0) {
    throw new Error("The hostname did not resolve to a public address.");
  }
  if (addresses.some(isPrivateAddress)) {
    throw new Error("Private and reserved network URLs are not supported.");
  }
  return normalized;
}

export async function cacheKeyForUrl(normalizedUrl: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalizedUrl),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `results/v1/${hash}.json`;
}

export function isXStatusUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return (
      (url.hostname === "x.com" || url.hostname === "www.x.com" ||
        url.hostname === "twitter.com" || url.hostname === "www.twitter.com") &&
      /^\/[^/]+\/(?:status|article)\/\d+/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
