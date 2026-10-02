/**
 * Thrown by job handlers / downstream clients when trying again later may succeed
 * (timeouts, 5xx, 429, simulated outages). The job runner reschedules with backoff.
 */
export class RetryableError extends Error {
  override name = "RetryableError";
  constructor(
    message: string,
    /** Minimum delay requested by the downstream (e.g. Discord's retry_after). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/**
 * Thrown when retrying cannot help (bad configuration, 4xx, expired interaction token).
 * The job runner dead-letters the job immediately so it shows up in the dashboard.
 */
export class PermanentError extends Error {
  override name = "PermanentError";
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

/** Timeouts and network failures from fetch() are worth retrying. */
export function asRetryable(err: unknown, what: string): Error {
  if (err instanceof RetryableError || err instanceof PermanentError) return err;
  const name = err instanceof Error ? err.name : "";
  const reason = name === "TimeoutError" || name === "AbortError" ? "timed out" : errorMessage(err);
  return new RetryableError(`${what}: ${reason}`);
}
