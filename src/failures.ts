export type FailureCode = "INVALID_REQUEST" | "INVALID_URL" | "BLOCKED" | "TOO_LARGE" | "TIMEOUT" | "UPSTREAM_ERROR" | "NO_CONTENT" | "BUDGET_EXHAUSTED";

export class ExtractionFailure extends Error {
  constructor(public code: FailureCode, message: string, public status = 502, public retryable = false) {
    super(message);
    this.name = "ExtractionFailure";
  }
}

export interface FailureResult {
  code: FailureCode;
  message: string;
  status: number;
  retryable: boolean;
}

export function describeFailure(error: unknown): FailureResult {
  if (error instanceof ExtractionFailure) return { code: error.code, message: error.message, status: error.status, retryable: error.retryable };
  const message = error instanceof Error ? error.message : "Extraction failed.";
  if (/security verification|bot challenge|HTTP (401|403)/i.test(message)) return { code: "BLOCKED", message, status: 502, retryable: false };
  if (/too large|5 MB|size limit|element limit/i.test(message)) return { code: "TOO_LARGE", message, status: 413, retryable: false };
  if (/private and reserved|credentials are not supported|only http and https|only standard web ports|did not resolve|enter a complete url/i.test(message)) return { code: "INVALID_URL", message, status: 400, retryable: false };
  if (error instanceof Error && /AbortError|TimeoutError/.test(error.name)) return { code: "TIMEOUT", message: "Extraction timed out.", status: 504, retryable: true };
  return { code: "UPSTREAM_ERROR", message, status: 502, retryable: false };
}
