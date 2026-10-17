import type { RiskLevel } from '../types';
import { riskLevel, riskSignal } from './reasons';

export interface RiskEvaluationResult {
  id?: string;
  level: RiskLevel;
  details: unknown;
  recommendedAction?: string;
}

export function buildRiskEvent(input: {
  ip?: string;
  userId: string;
  username: string;
  userType: 'PING_ONE' | 'EXTERNAL';
  userAgent: string;
  targetId: string;
  targetName: string;
  signals?: string;
  sessionId?: string;
}): Record<string, unknown> {
  const event: Record<string, unknown> = {
    flow: { type: 'AUTHENTICATION', subtype: 'USER_PASSWORD' },
    user: { id: input.userId, name: input.username, type: input.userType },
    browser: { userAgent: input.userAgent },
    targetResource: { id: input.targetId, name: input.targetName },
  };
  if (input.ip) event.ip = input.ip;
  if (input.signals) event.sdk = { signals: { data: input.signals } };
  if (input.sessionId) event.session = { id: input.sessionId };
  return event;
}

export class RiskEvaluationError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, status: number, retryAfterSeconds: number | null, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RiskEvaluationError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export async function createRiskEvaluation(input: {
  url: string;
  accessToken: string;
  event: Record<string, unknown>;
  riskPolicySetId?: string;
  fetchImpl?: typeof fetch;
}): Promise<RiskEvaluationResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body: Record<string, unknown> = { event: input.event };
  if (input.riskPolicySetId) body.riskPolicySet = { id: input.riskPolicySetId };
  const response = await fetchImpl(input.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      if (!response.ok) {
        throw new RiskEvaluationError(
          `Risk evaluation failed (${response.status}).`,
          response.status,
          response.status === 429 ? retryAfterSeconds(response) : null,
          { cause: error },
        );
      }
      throw error;
    }
  }
  if (!response.ok) {
    const message =
      (parsed.message as string | undefined) ||
      (parsed.details as { message?: string }[] | undefined)?.map((item) => item.message).filter(Boolean).join(' ') ||
      `Risk evaluation failed (${response.status}).`;
    throw new RiskEvaluationError(message, response.status, response.status === 429 ? retryAfterSeconds(response) : null);
  }
  const result = (parsed.result ?? {}) as { level?: unknown; score?: unknown; recommendedAction?: string };
  if (!riskSignal(result.level, result.score)) throw new Error('Risk evaluation did not return a level.');
  const level = riskLevel(result.level, result.score);
  return {
    id: typeof parsed.id === 'string' ? parsed.id : undefined,
    level,
    details: parsed.details,
    recommendedAction: typeof result.recommendedAction === 'string' ? result.recommendedAction : undefined,
  };
}

export async function updateRiskEvaluation(input: {
  url: string;
  accessToken: string;
  completionStatus: 'SUCCESS' | 'FAILED';
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ completionStatus: input.completionStatus }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Risk evaluation update failed (${response.status}).`);
  }
}

export const PUBLIC_IP_LOOKUP_TIMEOUT_MS = 2000;

const PUBLIC_IP_SOURCES = ['https://api.ipify.org?format=json', 'https://checkip.amazonaws.com/'];

export async function resolvePublicIp(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = PUBLIC_IP_LOOKUP_TIMEOUT_MS,
): Promise<string> {
  const errors: string[] = [];
  for (const url of PUBLIC_IP_SOURCES) {
    try {
      const ip = await readPublicIp(fetchImpl, url, timeoutMs);
      if (ip) return ip;
      errors.push('IP lookup did not return an address.');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(errors[0] || 'Public IP lookup failed.');
}

async function readPublicIp(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<string | undefined> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`IP lookup failed (${response.status}).`);
  const text = (await response.text()).trim();
  if (text.startsWith('{')) {
    const body = JSON.parse(text) as { ip?: unknown };
    return typeof body.ip === 'string' && isIpAddress(body.ip) ? body.ip : undefined;
  }
  const line = text.split(/\s+/)[0] ?? '';
  return isIpAddress(line) ? line : undefined;
}

function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get('retry-after')?.trim();
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, (date - Date.now()) / 1000);
  return null;
}

function isIpAddress(value: string): boolean {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) <= 255);
  }
  return value.includes(':') && /^[0-9a-fA-F:]+$/.test(value);
}
