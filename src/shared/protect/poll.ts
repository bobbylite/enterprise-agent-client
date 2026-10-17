import { RiskEvaluationError } from './evaluate';

export type ProtectPollFailure = 'rate-limit' | 'transient' | 'unavailable';

/** Next wait after a poll. `null` means polling is off. A 429 waits at least as long as Retry-After. */
export function nextProtectDelayMs(intervalSeconds: number, retryAfterSeconds: number | null = null): number | null {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return null;
  const intervalMs = intervalSeconds * 1000;
  if (retryAfterSeconds == null || !Number.isFinite(retryAfterSeconds)) return intervalMs;
  return Math.max(intervalMs, Math.max(0, retryAfterSeconds) * 1000);
}

export function classifyProtectPollFailure(error: unknown): ProtectPollFailure {
  if (error instanceof RiskEvaluationError) {
    if (error.status === 429) return 'rate-limit';
    if (error.status === 408 || error.status >= 500) return 'transient';
    return 'unavailable';
  }
  if (error instanceof TypeError) return 'transient';
  if (error instanceof Error && /fetch failed|network|ECONN|ETIMEDOUT|timed out|socket/i.test(error.message)) return 'transient';
  return 'unavailable';
}
