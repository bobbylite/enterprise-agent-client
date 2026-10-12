import type { RiskLevel, RiskReason, RiskReasonCode } from '../types';

const PREDICTORS: Record<string, { code: RiskReasonCode; label: string }> = {
  newDevice: { code: 'NEW_DEVICE', label: 'New device' },
  userLocationAnomaly: { code: 'ANOMALOUS_LOCATION', label: 'Anomalous location' },
  botDetection: { code: 'BOT', label: 'Bot' },
  ipReputation: { code: 'IP_REPUTATION', label: 'IP reputation' },
  anonymousNetwork: { code: 'ANONYMOUS_NETWORK', label: 'Anonymous network' },
};

interface PredictorShape {
  level?: string;
  reason?: string;
  status?: string;
}

export function extractRiskReasons(details: unknown): RiskReason[] {
  if (!details || typeof details !== 'object') return [];
  const record = details as Record<string, unknown>;
  const reasons: RiskReason[] = [];
  const seen = new Set<RiskReasonCode>();

  const push = (reason: RiskReason) => {
    if (seen.has(reason.code)) return;
    seen.add(reason.code);
    reasons.push(reason);
  };

  for (const [key, value] of Object.entries(record)) {
    const mapped = PREDICTORS[key];
    if (!mapped || !value || typeof value !== 'object') continue;
    const predictor = value as PredictorShape;
    const level = predictor.level?.toUpperCase();
    if (level !== 'HIGH' && level !== 'MEDIUM') continue;
    push({
      code: mapped.code,
      label: mapped.label,
      detail: typeof predictor.reason === 'string' ? predictor.reason : undefined,
    });
  }

  if (record.impossibleTravel === true) {
    const speed = typeof record.estimatedSpeed === 'number' ? ` Estimated speed ${record.estimatedSpeed} km/h.` : '';
    push({ code: 'IMPOSSIBLE_TRAVEL', label: 'Impossible travel', detail: `Travel between sign-ins is not physically plausible.${speed}` });
  }
  if (record.anonymousNetworkDetected === true) {
    push({ code: 'ANONYMOUS_NETWORK', label: 'Anonymous network', detail: 'The sign-in came from an anonymous network.' });
  }

  const reputation = record.ipAddressReputation as { level?: string } | undefined;
  if (reputation && (reputation.level === 'HIGH' || reputation.level === 'MEDIUM')) {
    push({ code: 'IP_REPUTATION', label: 'IP reputation', detail: `IP reputation is ${reputation.level}.` });
  }

  return reasons;
}

export function riskLevel(value: unknown): RiskLevel {
  const level = typeof value === 'string' ? value.toUpperCase() : '';
  if (level === 'HIGH' || level === 'MEDIUM' || level === 'LOW') return level;
  return 'HIGH';
}
