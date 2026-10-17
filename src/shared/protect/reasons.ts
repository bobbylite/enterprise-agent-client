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

/**
 * Protect sends `LOW` / `low` / `Low Risk`, or a 0–100 score when the level string is absent.
 * Scores below 30 are LOW, below 70 are MEDIUM, and 70 and above are HIGH. Anything else is UNKNOWN.
 */
export function riskLevel(value: unknown, score?: unknown): RiskLevel {
  return namedRiskLevel(value) ?? scoreRiskLevel(value) ?? scoreRiskLevel(score) ?? 'UNKNOWN';
}

export function riskSignal(value: unknown, score?: unknown): boolean {
  return namedRiskLevel(value) != null || scoreRiskLevel(value) != null || scoreRiskLevel(score) != null;
}

/** Sidebar color follows the level: LOW green, MEDIUM amber, HIGH red, unknown gray. */
export function riskIndicatorClass(level: unknown): 'good' | 'warn' | 'danger' | 'unknown' {
  const mapped = riskLevel(level);
  if (mapped === 'LOW') return 'good';
  if (mapped === 'MEDIUM') return 'warn';
  if (mapped === 'HIGH') return 'danger';
  return 'unknown';
}

function namedRiskLevel(value: unknown): RiskLevel | undefined {
  if (typeof value !== 'string') return undefined;
  const token = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!token) return undefined;
  if (token === 'LOW' || token === 'LOW_RISK') return 'LOW';
  if (token === 'MEDIUM' || token === 'MED' || token === 'MEDIUM_RISK') return 'MEDIUM';
  if (token === 'HIGH' || token === 'HIGH_RISK') return 'HIGH';
  if (token === 'UNKNOWN' || token === 'NONE' || token === 'UNSCORED' || token === 'UNSPECIFIED') return 'UNKNOWN';
  return undefined;
}

function scoreRiskLevel(value: unknown): RiskLevel | undefined {
  if (typeof value === 'string' && namedRiskLevel(value)) return undefined;
  const score = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(score) || score < 0 || score > 100) return undefined;
  if (score < 30) return 'LOW';
  if (score < 70) return 'MEDIUM';
  return 'HIGH';
}
