export type AiErrorCode =
  | "NOT_CONFIGURED"
  | "AUTH_ERROR"
  | "RATE_LIMITED"
  | "NETWORK_ERROR";

export class AiError extends Error {
  code: AiErrorCode;
  /** RATE_LIMITED only: epoch ms when the call may be retried. */
  retryAt?: number;

  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.name = "AiError";
    this.code = code;
  }
}

/**
 * Whether `err` is a provider rate-limit / quota rejection. Matches the HTTP
 * status the SDKs expose (OpenAI, Anthropic, @google/genai all set `.status`)
 * and the wording of the messages. Never match a bare "rate": it is inside
 * "generate", "moderate", "accurate"…, which used to turn ordinary failures
 * into fake rate limits.
 */
export function isRateLimitError(err: unknown): boolean {
  if (err instanceof AiError) return err.code === "RATE_LIMITED";
  const e = err as { status?: unknown; code?: unknown } | null;
  if (e?.status === 429 || e?.code === 429) return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /\b429\b|rate[\s_-]?limit|too many requests|RESOURCE_EXHAUSTED|quota exceeded|exceeded your current quota/i.test(
    message,
  );
}

/** Map any provider failure to an AiError (shared by every callAi). */
export function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401 || /\b401\b|authentication|invalid api key|api key not valid/i.test(message)) {
    return new AiError("AUTH_ERROR", "Invalid API key");
  }
  if (isRateLimitError(err)) {
    return new AiError("RATE_LIMITED", "Rate limited — please try again shortly");
  }
  return new AiError("NETWORK_ERROR", message);
}
