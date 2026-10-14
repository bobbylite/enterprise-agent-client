import type { FeatureDecision, RiskAction, RiskLevel } from '../types';

export const FEATURE_STATEMENT = 'enterprise-agent-features';
export const SCAFFOLD_MARKER = 'enterprise-agent-scaffold';

export type FeatureFlags = Pick<FeatureDecision, 'policyTab' | 'pingoneTools' | 'mcpWrites' | 'chat'>;

export interface PolicyWhen {
  /** User must belong to at least one of these groups. */
  groupsAny?: string[];
  riskLevels?: RiskLevel[];
  riskActions?: RiskAction[];
  /** When several fields are set, `all` requires every one and `any` requires one. */
  match?: 'all' | 'any';
}

export interface AuthorizePolicy {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
  scaffold: boolean;
  remoteId: string | null;
  when: PolicyWhen;
  effect: Partial<FeatureFlags>;
}

export interface DecisionInput {
  groups: string[];
  riskLevel: RiskLevel;
  riskAction: RiskAction;
}

export function failClosed(now: number): FeatureDecision {
  return {
    policyTab: false,
    pingoneTools: false,
    mcpWrites: false,
    chat: 'read_only',
    source: 'fail_closed',
    fetchedAt: now,
  };
}

export function riskScore(level: RiskLevel): number {
  if (level === 'LOW') return 10;
  if (level === 'MEDIUM') return 50;
  if (level === 'HIGH') return 90;
  return 0;
}

export function decisionParameters(input: DecisionInput & { userId: string; username: string }): {
  parameters: Record<string, string>;
  userContext: { user: { id: string } };
} {
  return {
    parameters: {
      'user.id': input.userId,
      'user.name': input.username,
      'user.groups': JSON.stringify(input.groups),
      'risk.level': input.riskLevel,
      'risk.score': String(riskScore(input.riskLevel)),
      'risk.action': input.riskAction,
    },
    userContext: { user: { id: input.userId } },
  };
}

export function scaffoldPolicies(adminGroup: string, now: number, updatedBy: string): AuthorizePolicy[] {
  const stamp = { updatedAt: now, updatedBy, enabled: true, scaffold: true, remoteId: null };
  return [
    {
      ...stamp,
      id: 'enterprise-agent:session',
      name: 'Session can use chat',
      description:
        'When Protect risk is low, medium, or unknown, and the action is allow, step-up, or restrict tools, chat stays available and MCP writes can still be approved.',
      when: {
        riskLevels: ['LOW', 'MEDIUM', 'UNKNOWN'],
        riskActions: ['allow', 'step_up_mfa', 'restrict_tools'],
        match: 'all',
      },
      effect: { chat: 'allow', mcpWrites: true },
    },
    {
      ...stamp,
      id: 'enterprise-agent:admin',
      name: 'Administrator tools',
      description: `Members of ${adminGroup} can open the Policy tab and use PingOne tools. Add another policy with when.groupsAny to grant a different group its own tools.`,
      when: { groupsAny: [adminGroup] },
      effect: { policyTab: true, pingoneTools: true },
    },
    {
      ...stamp,
      id: 'enterprise-agent:read-only',
      name: 'Read-only risk',
      description: 'A read-only Protect action disables MCP writes and makes chat read-only.',
      when: { riskActions: ['read_only'] },
      effect: { mcpWrites: false, chat: 'read_only' },
    },
    {
      ...stamp,
      id: 'enterprise-agent:high-risk',
      name: 'High risk lockdown',
      description: 'High risk or a blocked session hides admin tools, disables MCP writes, and makes chat read-only.',
      when: { riskLevels: ['HIGH'], riskActions: ['block'], match: 'any' },
      effect: { policyTab: false, pingoneTools: false, mcpWrites: false, chat: 'read_only' },
    },
  ];
}

export function mergeScaffold(existing: AuthorizePolicy[], incoming: AuthorizePolicy[]): {
  policies: AuthorizePolicy[];
  created: AuthorizePolicy[];
} {
  const ids = new Set(existing.map((policy) => policy.id));
  const created = incoming.filter((policy) => !ids.has(policy.id));
  return { policies: [...existing, ...created], created };
}

export interface ListedAuthorizationPolicy {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  updatedAt: number | null;
}

export function remoteOwnsStarter(
  remote: { name: string; description: string },
  starter: { id: string; name: string },
): boolean {
  const marker = parseScaffoldMarker(remote.description);
  if (marker?.id === starter.id) return true;
  if (!remote.description.includes(SCAFFOLD_MARKER)) return false;
  return remote.description.includes(starter.id) || remote.name === starter.name;
}

export function reconcilePolicyCache(
  local: AuthorizePolicy[],
  remote: ListedAuthorizationPolicy[],
  starters: AuthorizePolicy[],
): { dropIds: string[]; missing: AuthorizePolicy[] } {
  const remoteIds = new Set(remote.map((item) => item.id).filter((id) => id.length > 0));
  const dropIds = local
    .filter((policy) => {
      const liveById = policy.remoteId ? remoteIds.has(policy.remoteId) : false;
      const liveByMarker = remote.some((item) => remoteOwnsStarter(item, policy));
      if (isScaffoldRow(policy)) return !liveById && !liveByMarker;
      return Boolean(policy.remoteId) && !liveById;
    })
    .map((policy) => policy.id);
  const missing = starters.filter((starter) => !remote.some((item) => remoteOwnsStarter(item, starter)));
  return { dropIds, missing };
}

function isScaffoldRow(policy: AuthorizePolicy): boolean {
  return policy.scaffold || policy.id.startsWith('enterprise-agent:') || policy.description.includes(SCAFFOLD_MARKER);
}

const SCAFFOLD_RANK = [
  'enterprise-agent:session',
  'enterprise-agent:admin',
  'enterprise-agent:read-only',
  'enterprise-agent:high-risk',
];

function scaffoldRank(id: string): number {
  const index = SCAFFOLD_RANK.indexOf(id);
  return index === -1 ? -1 : index;
}

export function parseScaffoldMarker(description: string): { id: string; when: PolicyWhen; effect: Partial<FeatureFlags> } | null {
  const index = description.indexOf(SCAFFOLD_MARKER);
  if (index < 0) return null;
  const json = description.slice(index + SCAFFOLD_MARKER.length).trim();
  try {
    const parsed = JSON.parse(json) as { id?: unknown; when?: PolicyWhen; effect?: Partial<FeatureFlags> };
    if (typeof parsed.id !== 'string' || !parsed.id) return null;
    return { id: parsed.id, when: parsed.when ?? {}, effect: parsed.effect ?? {} };
  } catch {
    return null;
  }
}

export function evaluatePolicies(policies: AuthorizePolicy[], input: DecisionInput, now: number): FeatureDecision {
  const flags: FeatureFlags = { policyTab: false, pingoneTools: false, mcpWrites: false, chat: 'read_only' };
  const ordered = [...policies].sort((left, right) => scaffoldRank(left.id) - scaffoldRank(right.id));
  for (const policy of ordered) {
    if (!policy.enabled || !matches(policy.when, input)) continue;
    if (policy.effect.policyTab !== undefined) flags.policyTab = policy.effect.policyTab;
    if (policy.effect.pingoneTools !== undefined) flags.pingoneTools = policy.effect.pingoneTools;
    if (policy.effect.mcpWrites !== undefined) flags.mcpWrites = policy.effect.mcpWrites;
    if (policy.effect.chat !== undefined) flags.chat = policy.effect.chat;
  }
  return { ...flags, source: 'starter', fetchedAt: now };
}

export function featuresFromAuthorize(body: unknown, now: number): FeatureDecision | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as { decision?: unknown; statements?: unknown };
  const decision = typeof record.decision === 'string' ? record.decision.toUpperCase() : '';
  if (decision === 'DENY') return failClosed(now);
  const statements = Array.isArray(record.statements) ? record.statements : [];
  for (const statement of statements) {
    if (!statement || typeof statement !== 'object') continue;
    const code = (statement as { code?: unknown }).code;
    if (code !== FEATURE_STATEMENT) continue;
    const payload = parsePayload((statement as { payload?: unknown }).payload);
    if (!payload) continue;
    return {
      policyTab: payload.policyTab === true,
      pingoneTools: payload.pingoneTools === true,
      mcpWrites: payload.mcpWrites === true,
      chat: payload.chat === 'read_only' ? 'read_only' : 'allow',
      source: 'authorize',
      fetchedAt: now,
    };
  }
  return null;
}

function parsePayload(value: unknown): Partial<FeatureFlags> | null {
  const record =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (!record || typeof record !== 'object') return null;
  return record as Partial<FeatureFlags>;
}

function matches(when: PolicyWhen, input: DecisionInput): boolean {
  const checks: boolean[] = [];
  if (when.groupsAny && when.groupsAny.length > 0) {
    checks.push(when.groupsAny.some((group) => input.groups.includes(group)));
  }
  if (when.riskLevels && when.riskLevels.length > 0) checks.push(when.riskLevels.includes(input.riskLevel));
  if (when.riskActions && when.riskActions.length > 0) checks.push(when.riskActions.includes(input.riskAction));
  if (checks.length === 0) return true;
  return when.match === 'any' ? checks.some(Boolean) : checks.every(Boolean);
}

export function decisionCacheKey(input: DecisionInput): string {
  return `${[...input.groups].sort().join(',')}|${input.riskLevel}|${input.riskAction}`;
}
