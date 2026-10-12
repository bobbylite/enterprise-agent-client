import type { ApprovalChoice, RiskAction } from '../types';

export interface ApprovalInput {
  riskAction: RiskAction;
  readOnlyHint: boolean;
  remembered?: 'always' | 'deny';
}

export type ApprovalPreview =
  | { type: 'allow'; persistence: 'once' | 'always'; automatic: boolean }
  | { type: 'deny'; reason: string; automatic: boolean }
  | { type: 'prompt'; allowAlways: boolean };

export function previewApproval(input: ApprovalInput): ApprovalPreview {
  if (input.riskAction === 'block') {
    return { type: 'deny', reason: 'This session is blocked by the risk policy.', automatic: true };
  }
  if (input.riskAction === 'read_only' && !input.readOnlyHint) {
    return {
      type: 'deny',
      reason: 'This session is read-only. The tool is not marked read-only.',
      automatic: true,
    };
  }
  if (input.remembered === 'deny') {
    return { type: 'deny', reason: 'You previously denied this tool.', automatic: true };
  }
  if (input.remembered === 'always' && input.riskAction !== 'restrict_tools') {
    return { type: 'allow', persistence: 'always', automatic: true };
  }
  return { type: 'prompt', allowAlways: input.riskAction !== 'restrict_tools' };
}

export type ApprovalDecision = Extract<ApprovalPreview, { type: 'allow' | 'deny' }>;

export function choiceFromUser(choice: ApprovalChoice, allowAlways: boolean): ApprovalDecision {
  if (choice === 'deny') return { type: 'deny', reason: 'You denied this tool call.', automatic: false };
  if (choice === 'always' && allowAlways) return { type: 'allow', persistence: 'always', automatic: false };
  return { type: 'allow', persistence: 'once', automatic: false };
}

export function toolKey(serverId: string, toolName: string): string {
  const raw = `${serverId}__${toolName}`;
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'tool';
}
