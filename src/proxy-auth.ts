/** Compare shared proxy secrets using Web Crypto, without a string comparison. */
export async function verifyProxySecret(candidate: string | null, expected?: string): Promise<boolean> {
  if (!candidate || !expected || candidate.length > 512) return false;
  const bytes = new TextEncoder();
  const algorithm = { name: "HMAC", hash: "SHA-256" };
  const message = bytes.encode("repruv-internal-extraction-v1");
  const candidateKey = await crypto.subtle.importKey("raw", bytes.encode(candidate), algorithm, false, ["sign"]);
  const expectedKey = await crypto.subtle.importKey("raw", bytes.encode(expected), algorithm, false, ["verify"]);
  const signature = await crypto.subtle.sign("HMAC", candidateKey, message);
  return crypto.subtle.verify("HMAC", expectedKey, signature, message);
}
