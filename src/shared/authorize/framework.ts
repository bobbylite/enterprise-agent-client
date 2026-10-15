import { createHash } from 'node:crypto';
import type { EnterpriseConfig } from '../config';
import { FEATURE_STATEMENT, riskScore, type DecisionInput } from './policy';

/** Trust Framework parent. Children use this prefix as their full attribute name. */
export const TRUST_PARENT = 'EnterpriseAgent';

export const REQUEST_ATTRIBUTES = [
  { name: 'access-token', valueType: 'STRING' },
  { name: 'tx-token', valueType: 'STRING' },
  { name: 'risk-level', valueType: 'STRING' },
  { name: 'risk-score', valueType: 'NUMBER' },
  { name: 'risk-action', valueType: 'STRING' },
  { name: 'admin-group', valueType: 'STRING' },
] as const;

export const CLIENT_ID_DEFINITION = 'introspect-client-id';
export const CLIENT_SECRET_DEFINITION = 'introspect-client-secret';

export const USER_SERVICE = 'EnterpriseAgent User Introspection';
export const DELEGATION_SERVICE = 'EnterpriseAgent Delegation Introspection';

export const SERVICE_ATTRIBUTES = [
  { name: 'introspection-active', service: USER_SERVICE, path: '$.active' },
  { name: 'introspection-groups', service: USER_SERVICE, path: '$.groups' },
  { name: 'introspection-sub', service: USER_SERVICE, path: '$.sub' },
  { name: 'tx-active', service: DELEGATION_SERVICE, path: '$.active' },
  { name: 'tx-sub', service: DELEGATION_SERVICE, path: '$.sub' },
  { name: 'tx-act-sub', service: DELEGATION_SERVICE, path: '$.act.sub' },
  { name: 'tx-aud', service: DELEGATION_SERVICE, path: '$.aud' },
  { name: 'tx-scope', service: DELEGATION_SERVICE, path: '$.scope' },
] as const;

export const ROOT_POLICY = 'Enterprise Agent';
export const USER_POLICY = 'Enterprise Agent User';
export const DELEGATION_POLICY = 'Enterprise Agent Delegation';
export const DECISION_ENDPOINT = 'Enterprise Agent';

export interface DelegationGrant {
  humanSub: string;
  agentSub: string;
  audience: string;
  scope: string;
}

export interface DecisionCall extends DecisionInput {
  userId: string;
  username: string;
  accessToken: string;
  txToken: string;
  adminGroup: string;
  parentName?: string;
}

export function fullAttributeName(parent: string, name: string): string {
  return `${parent}.${name}`;
}

/** Both tokens are required. An empty token makes introspection return 400 and the decision indeterminate. */
export function decisionTokensReady(accessToken: string, txToken: string): boolean {
  return accessToken.trim().length > 0 && txToken.trim().length > 0;
}

export function decisionParameters(input: DecisionCall): {
  parameters: Record<string, string | number>;
  userContext: { user: { id: string } };
} {
  const parent = input.parentName?.trim() || TRUST_PARENT;
  const level = input.riskLevel || 'UNKNOWN';
  return {
    parameters: {
      [fullAttributeName(parent, 'access-token')]: input.accessToken,
      [fullAttributeName(parent, 'tx-token')]: input.txToken,
      [fullAttributeName(parent, 'risk-level')]: level,
      [fullAttributeName(parent, 'risk-score')]: riskScore(level),
      [fullAttributeName(parent, 'risk-action')]: input.riskAction || 'allow',
      [fullAttributeName(parent, 'admin-group')]: input.adminGroup || 'Administrator',
    },
    userContext: { user: { id: input.userId } },
  };
}

export function introspectUrl(config: EnterpriseConfig): string {
  const host = config.tenant.authHost.replace(/\/$/, '') || 'https://auth.pingone.com';
  return `${host}/${config.tenant.environmentId}/as/introspect`;
}

export function parentAttributeBody(): Record<string, unknown> {
  return {
    name: TRUST_PARENT,
    description: 'Parent for Enterprise Agent decision attributes. Not an API Access Management attribute.',
    type: 'ATTRIBUTE',
    valueType: { type: 'JSON' },
    resolvers: [{ type: 'CONSTANT', value: '{}' }],
  };
}

export function requestAttributeBody(parentId: string, name: string, valueType: string): Record<string, unknown> {
  return {
    name,
    description: `Request parameter ${fullAttributeName(TRUST_PARENT, name)}. No processor: the resolver already returns the scalar.`,
    type: 'ATTRIBUTE',
    parent: { id: parentId },
    resolvers: [{ type: 'REQUEST' }],
    valueType: { type: valueType },
  };
}

export function definitionBody(parentId: string, name: string, secret: boolean): Record<string, unknown> {
  return {
    name,
    description: secret
      ? 'Paste the custom resource client secret in the PingOne console. Scaffold never writes this secret.'
      : 'Paste the custom resource client id in the PingOne console if it is not already set.',
    type: 'ATTRIBUTE',
    parent: { id: parentId },
    resolvers: [{ type: 'CONSTANT', value: '' }],
    valueType: { type: 'STRING' },
  };
}

export function serviceBody(name: string, url: string, tokenAttributeId: string, clientIdDefinitionId: string, secretDefinitionId: string): Record<string, unknown> {
  return {
    name,
    description: 'RFC 7662 introspection. Basic auth uses Trust Framework Definitions, not the OAuth resource id.',
    type: 'SERVICE',
    serviceType: 'HTTP',
    serviceSettings: {
      type: 'HTTP',
      url,
      verb: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: `token={{${tokenAttributeId}}}`,
      authentication: {
        type: 'BASIC',
        name: { id: clientIdDefinitionId },
        password: { id: secretDefinitionId },
      },
      tlsSettings: { tlsValidationType: 'DEFAULT' },
      timeoutMilliseconds: 3000,
    },
    valueType: { type: 'JSON' },
  };
}

export function serviceAttributeBody(parentId: string, name: string, serviceId: string, path: string): Record<string, unknown> {
  return {
    name,
    description: `Claim ${path} from introspection. JSONPath is used because the service returns JSON.`,
    type: 'ATTRIBUTE',
    parent: { id: parentId },
    resolvers: [{ type: 'SERVICE', value: { id: serviceId } }],
    processor: { type: 'JSON_PATH', expression: path, valueType: { type: 'STRING' } },
    valueType: { type: 'STRING' },
  };
}

export interface ConditionPlan {
  op: 'and' | 'or' | 'eq' | 'neq' | 'contains';
  attribute?: string;
  value?: string;
  conditions?: ConditionPlan[];
}

export interface RulePlan {
  name: string;
  effect: 'PERMIT' | 'DENY';
  condition: ConditionPlan;
  payload: Record<string, boolean | string>;
}

const LOCKDOWN = { policyTab: false, pingoneTools: false, mcpWrites: false, chat: 'read_only' };
const READ_ONLY = { policyTab: true, pingoneTools: false, mcpWrites: false, chat: 'read_only' };
const ADMIN = { policyTab: true, pingoneTools: true, mcpWrites: true, chat: 'allow' };
const SESSION = { policyTab: false, pingoneTools: false, mcpWrites: true, chat: 'allow' };

export function userRulePlans(adminGroup: string): RulePlan[] {
  return [
    {
      name: 'High risk or inactive token',
      effect: 'DENY',
      condition: {
        op: 'or',
        conditions: [
          { op: 'eq', attribute: 'risk-level', value: 'HIGH' },
          { op: 'eq', attribute: 'risk-action', value: 'block' },
          { op: 'eq', attribute: 'introspection-active', value: 'false' },
        ],
      },
      payload: LOCKDOWN,
    },
    {
      name: 'Read-only risk',
      effect: 'PERMIT',
      condition: { op: 'eq', attribute: 'risk-action', value: 'read_only' },
      payload: READ_ONLY,
    },
    {
      name: 'Administrator',
      effect: 'PERMIT',
      condition: { op: 'contains', attribute: 'introspection-groups', value: adminGroup },
      payload: ADMIN,
    },
    {
      name: 'Active session',
      effect: 'PERMIT',
      condition: { op: 'eq', attribute: 'introspection-active', value: 'true' },
      payload: SESSION,
    },
  ];
}

export function delegationRulePlans(grants: DelegationGrant[]): RulePlan[] {
  const plans: RulePlan[] = [];
  const mappings = grants.filter((grant) => grant.humanSub.trim() && grant.agentSub.trim());
  if (mappings.length > 0) {
    plans.push({
      name: 'Mapped human and agent',
      effect: 'PERMIT',
      condition: {
        op: 'or',
        conditions: mappings.map((grant) => ({
          op: 'and' as const,
          conditions: [
            { op: 'eq' as const, attribute: 'tx-sub', value: grant.humanSub },
            { op: 'eq' as const, attribute: 'tx-act-sub', value: grant.agentSub },
            ...(grant.audience.trim() ? [{ op: 'eq' as const, attribute: 'tx-aud', value: grant.audience }] : []),
            ...(grant.scope.trim() ? [{ op: 'eq' as const, attribute: 'tx-scope', value: grant.scope }] : []),
          ],
        })),
      },
      payload: SESSION,
    });
  }
  plans.push({
    name: 'Active delegation',
    effect: 'PERMIT',
    condition: {
      op: 'and',
      conditions: [
        { op: 'eq', attribute: 'tx-active', value: 'true' },
        { op: 'neq', attribute: 'tx-act-sub', value: '' },
      ],
    },
    payload: SESSION,
  });
  return plans;
}

export function ruleSetHash(plans: RulePlan[]): string {
  return createHash('sha256').update(JSON.stringify(plans)).digest('hex');
}

export function conditionBody(plan: ConditionPlan, attributeIds: Map<string, string>): Record<string, unknown> {
  if (plan.op === 'and' || plan.op === 'or') {
    return {
      type: plan.op === 'and' ? 'AND' : 'OR',
      conditions: (plan.conditions ?? []).map((child) => conditionBody(child, attributeIds)),
    };
  }
  const attribute = plan.attribute ?? '';
  const id = attributeIds.get(attribute);
  if (!id) throw new Error(`No Trust Framework id for ${attribute}.`);
  const comparator = plan.op === 'neq' ? 'NOT_EQUALS' : plan.op === 'contains' ? 'CONTAINS' : 'EQUALS';
  return {
    type: 'COMPARISON',
    left: { type: 'ATTRIBUTE', id },
    comparator,
    right: { type: 'CONSTANT', value: plan.value ?? '' },
  };
}

export function statementBody(plan: RulePlan): Record<string, unknown> {
  return {
    name: FEATURE_STATEMENT,
    code: FEATURE_STATEMENT,
    obligatory: true,
    appliesTo: plan.effect === 'DENY' ? 'DENY' : 'PERMIT',
    appliesIf: 'PATH_MATCHES',
    attributes: [],
    payload: JSON.stringify(plan.payload),
  };
}

export function ruleBody(plan: RulePlan, attributeIds: Map<string, string>, existing?: { id: string; version: string }): Record<string, unknown> {
  const rule: Record<string, unknown> = {
    type: 'RULE',
    name: plan.name,
    enabled: true,
    effectSettings: { type: plan.effect === 'DENY' ? 'UNCONDITIONAL_DENY' : 'UNCONDITIONAL_PERMIT' },
    condition: conditionBody(plan.condition, attributeIds),
    statements: [statementBody(plan)],
  };
  if (existing) {
    rule.id = existing.id;
    rule.version = existing.version;
  }
  return rule;
}

export function policyShell(name: string, description: string, algorithm: 'DENY_OVERRIDES' | 'FIRST_APPLICABLE'): Record<string, unknown> {
  return {
    type: 'POLICY',
    name,
    description,
    combiningAlgorithm: { algorithm },
    enabled: true,
    children: [],
  };
}

export function writablePolicy(current: Record<string, unknown>, children: unknown[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    if (key.startsWith('_') || key === 'environment' || key === 'managedEntity' || key === 'parent') continue;
    body[key] = value;
  }
  if (typeof body.id !== 'string' || !body.id || typeof body.version !== 'string' || !body.version) {
    throw new Error('PingOne policy is missing id or version.');
  }
  body.type = 'POLICY';
  body.children = children;
  return body;
}

export function rulesReferenceIsApproved(value: unknown): boolean {
  return JSON.stringify(value).includes('isApproved');
}

export function lastRuleDeniesUnconditionally(rules: RulePlan[]): boolean {
  const last = rules[rules.length - 1];
  if (!last || last.effect !== 'DENY') return false;
  return last.condition.op !== 'and' && last.condition.op !== 'or' && last.condition.op !== 'eq' && last.condition.op !== 'neq' && last.condition.op !== 'contains';
}

/** Groups use CONTAINS on the whole $.groups value. A JSONPath filter that matches nothing throws and would halt FIRST_APPLICABLE before the session rule. */
export function groupsComparisonUsesCollection(): boolean {
  return true;
}
