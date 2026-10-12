import type { RiskLevel } from '../types';

export interface RiskEvaluationResult {
  id?: string;
  level: RiskLevel;
  details: unknown;
  recommendedAction?: string;
}

export function buildRiskEvent(input: {
  ip: string;
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
    ip: input.ip,
    flow: { type: 'AUTHENTICATION', subtype: 'USER_PASSWORD' },
    user: { id: input.userId, name: input.username, type: input.userType },
    browser: { userAgent: input.userAgent },
    targetResource: { id: input.targetId, name: input.targetName },
  };
  if (input.signals) event.sdk = { signals: { data: input.signals } };
  if (input.sessionId) event.session = { id: input.sessionId };
  return event;
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
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    const message =
      (parsed.message as string | undefined) ||
      (parsed.details as { message?: string }[] | undefined)?.map((item) => item.message).filter(Boolean).join(' ') ||
      `Risk evaluation failed (${response.status}).`;
    throw new Error(message);
  }
  const result = (parsed.result ?? {}) as { level?: string; recommendedAction?: string };
  const level = result.level?.toUpperCase();
  if (level !== 'LOW' && level !== 'MEDIUM' && level !== 'HIGH') {
    throw new Error('Risk evaluation did not return a level.');
  }
  return {
    id: typeof parsed.id === 'string' ? parsed.id : undefined,
    level,
    details: parsed.details,
    recommendedAction: result.recommendedAction,
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

export async function resolvePublicIp(fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl('https://api.ipify.org?format=json');
  if (!response.ok) throw new Error(`IP lookup failed (${response.status}).`);
  const body = (await response.json()) as { ip?: string };
  if (!body.ip) throw new Error('IP lookup did not return an address.');
  return body.ip;
}
