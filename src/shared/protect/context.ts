import type { RiskView } from '../types';
import { actionLabel } from './policy';

export function renderRiskContext(risk: RiskView, agentName: string): string {
  const reasonText =
    risk.reasons.length > 0
      ? risk.reasons
          .map((reason) => (reason.detail ? `${reason.label} (${reason.detail})` : reason.label))
          .join('; ')
      : 'none';
  return [
    'Session risk context (authoritative for this sign-in):',
    `Risk level: ${risk.level}.`,
    ...(risk.level === 'UNKNOWN'
      ? ['Protect did not score this sign-in. The policy action below is the limit.']
      : []),
    `Reasons: ${reasonText}.`,
    `Policy action: ${risk.action}.`,
    `You are ${agentName}. When the user asks what you can do, or when a tool is refused, explain this risk state in plain language and follow it.`,
    behaviorLine(risk),
  ].join('\n');
}

function behaviorLine(risk: RiskView): string {
  switch (risk.action) {
    case 'allow':
      return 'Behaviour: tools may be offered and still require the user approval policy.';
    case 'step_up_mfa':
      return 'Behaviour: step-up verification was required before this session became active. Do not offer a way around it.';
    case 'restrict_tools':
      return 'Behaviour: every tool call needs a fresh approval. Do not treat an earlier allow as still in force.';
    case 'read_only':
      return 'Behaviour: only tools marked read-only may run. Do not attempt changes, writes, or deletions.';
    case 'block':
      return 'Behaviour: this session is blocked. Do not call tools or claim that work was completed.';
  }
}

export function actionExplanation(action: RiskView['action']): string {
  return actionLabel(action);
}
