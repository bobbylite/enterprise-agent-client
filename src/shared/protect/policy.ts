import type { RiskAction, RiskLevel, RiskReason, RiskView } from '../types';
import type { RiskPolicyConfig } from '../config';

const SEVERITY: Record<RiskAction, number> = {
  allow: 0,
  step_up_mfa: 1,
  restrict_tools: 2,
  read_only: 3,
  block: 4,
};

export function decideRisk(policy: RiskPolicyConfig, level: RiskLevel, reasons: RiskReason[]): RiskAction {
  const actions: RiskAction[] = [policy.levels[level]];
  for (const reason of reasons) {
    const override = policy.reasonOverrides.find((item) => item.code === reason.code);
    if (override) actions.push(override.action);
  }
  return actions.sort((left, right) => SEVERITY[right] - SEVERITY[left])[0] ?? 'block';
}

export function summarizeRisk(level: RiskLevel, action: RiskAction, reasons: RiskReason[]): string {
  const why = reasons.length > 0 ? reasons.map((reason) => reason.label).join(', ') : 'no elevated predictors';
  return `${level} risk (${why}). Policy: ${actionLabel(action)}.`;
}

export function unscoredRisk(policy: RiskPolicyConfig, evaluatedAt: number, signalsCollected: boolean): RiskView {
  const reasons: RiskReason[] = [
    {
      code: 'OTHER',
      label: 'Client IP unavailable',
      detail: 'Public IP lookup failed, and Protect did not accept a risk evaluation without an IP.',
    },
  ];
  const level: RiskLevel = 'UNKNOWN';
  const action = decideRisk(policy, level, reasons);
  return {
    level,
    action,
    reasons,
    summary: summarizeRisk(level, action, reasons),
    signalsCollected,
    evaluatedAt,
  };
}

export function actionLabel(action: RiskAction): string {
  switch (action) {
    case 'allow':
      return 'allow';
    case 'step_up_mfa':
      return 'step-up verification';
    case 'restrict_tools':
      return 'approve every tool call';
    case 'read_only':
      return 'read-only';
    case 'block':
      return 'block';
  }
}
