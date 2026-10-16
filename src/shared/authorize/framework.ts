import { createHash } from 'node:crypto';
import type { EnterpriseConfig } from '../config';
import { FEATURE_STATEMENT, riskScore, type DecisionInput } from './policy';

/** Trust Framework parent. Children use this prefix as their full attribute name. */
export const TRUST_PARENT = 'EnterpriseAgent';

export type AttributeValueType = 'STRING' | 'NUMBER' | 'JSON' | 'BOOLEAN';

export interface ValueTypeSpec {
  type: AttributeValueType;
}

export interface ResolverSpec {
  type: 'REQUEST' | 'CONSTANT' | 'SERVICE';
  valueType: ValueTypeSpec;
  /** Constant literal. Definitions stay empty so a console-entered secret is not overwritten. */
  value?: string;
  service?: string;
}

export interface AttributeSpec {
  name: string;
  description: string;
  valueType: ValueTypeSpec;
  resolvers: ResolverSpec[];
  processor?: { type: 'JSON_PATH'; name: string; expression: string; valueType: ValueTypeSpec };
}

const REQUEST_ATTRIBUTE_SPECS: { name: string; valueType: AttributeValueType }[] = [
  { name: 'access-token', valueType: 'STRING' },
  { name: 'tx-token', valueType: 'STRING' },
  { name: 'risk-level', valueType: 'STRING' },
  { name: 'risk-score', valueType: 'NUMBER' },
  { name: 'risk-action', valueType: 'STRING' },
  { name: 'admin-group', valueType: 'STRING' },
];

export const REQUEST_ATTRIBUTES = REQUEST_ATTRIBUTE_SPECS;

/** Enterprise agent / token-exchange client. Delegation introspection keeps these. */
export const CLIENT_ID_DEFINITION = 'introspect-client-id';
export const CLIENT_SECRET_DEFINITION = 'introspect-client-secret';
/** SSO login application. User introspection sends this id as client_id and does not authenticate. */
export const USER_CLIENT_ID_DEFINITION = 'user-introspect-client-id';

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

export const ROOT_POLICY = 'Enterprise Agent Features';
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

function typed(type: AttributeValueType): ValueTypeSpec {
  return { type };
}

function requestSpec(name: string, valueType: AttributeValueType): AttributeSpec {
  return {
    name,
    description: `Request parameter ${fullAttributeName(TRUST_PARENT, name)}. No processor: the resolver already returns the scalar.`,
    valueType: typed(valueType),
    resolvers: [{ type: 'REQUEST', valueType: typed(valueType) }],
  };
}

function definitionSpec(name: string, secret: boolean, subject: string): AttributeSpec {
  const description = secret
    ? `${subject} client secret. Scaffold can copy it from the keychain into this Definition. It is never written to dry-run output, logs, or the decision trace.`
    : name === USER_CLIENT_ID_DEFINITION
      ? 'SSO login application client id. Scaffold copies tenant.clientId onto this Definition. User introspection sends it as client_id and does not use a secret.'
      : `${subject} client id.`;
  return {
    name,
    description,
    valueType: typed('STRING'),
    resolvers: [{ type: 'CONSTANT', value: '', valueType: typed('STRING') }],
  };
}

function serviceSpec(name: string, service: string, path: string): AttributeSpec {
  return {
    name,
    description: `Claim ${path} from introspection. JSONPath is used because the service returns JSON.`,
    valueType: typed('STRING'),
    resolvers: [{ type: 'SERVICE', valueType: typed('STRING'), service }],
    processor: { type: 'JSON_PATH', name: `Extract ${name}`, expression: path, valueType: typed('STRING') },
  };
}

/** Concrete attribute specs. Every attribute and every resolver has a valueType before any HTTP call. */
export function attributePlan(): AttributeSpec[] {
  return [
    {
      name: TRUST_PARENT,
      description: 'Parent for Enterprise Agent decision attributes. Not an API Access Management attribute.',
      valueType: typed('JSON'),
      resolvers: [{ type: 'CONSTANT', value: '{}', valueType: typed('JSON') }],
    },
    ...REQUEST_ATTRIBUTE_SPECS.map((attribute) => requestSpec(attribute.name, attribute.valueType)),
    definitionSpec(USER_CLIENT_ID_DEFINITION, false, 'SSO login application'),
    definitionSpec(CLIENT_ID_DEFINITION, false, 'Enterprise agent token-exchange client'),
    definitionSpec(CLIENT_SECRET_DEFINITION, true, 'Enterprise agent token-exchange client'),
    ...SERVICE_ATTRIBUTES.map((attribute) => serviceSpec(attribute.name, attribute.service, attribute.path)),
  ];
}

/** The plan Scaffold will write, built from the enterprise config with no HTTP. */
export function scaffoldPlan(config: EnterpriseConfig): {
  attributes: AttributeSpec[];
  services: { name: string; valueType: ValueTypeSpec; tokenAttribute: string; url: string }[];
} {
  return {
    attributes: attributePlan(),
    services: [
      { name: USER_SERVICE, valueType: typed('JSON'), tokenAttribute: 'access-token', url: introspectUrl(config) },
      { name: DELEGATION_SERVICE, valueType: typed('JSON'), tokenAttribute: 'tx-token', url: introspectUrl(config) },
    ],
  };
}

export function attributeSpec(name: string): AttributeSpec {
  const spec = attributePlan().find((item) => item.name === name);
  if (!spec) throw new Error(`No attribute spec for ${name}.`);
  if (!spec.valueType?.type) throw new Error(`${name} attribute valueType is undefined.`);
  for (const resolver of spec.resolvers) {
    if (!resolver.valueType?.type) throw new Error(`${name} resolver valueType is undefined.`);
  }
  if (spec.processor && (!spec.processor.name || !spec.processor.valueType?.type || !spec.processor.expression)) {
    throw new Error(`${name} processor is missing name, expression, or valueType.`);
  }
  return spec;
}

export function attributeBody(
  name: string,
  links: { parentId?: string; serviceId?: string; constantValue?: string } = {},
): Record<string, unknown> {
  const spec = attributeSpec(name);
  const resolvers = spec.resolvers.map((resolver) => {
    const written: Record<string, unknown> = { type: resolver.type, valueType: resolver.valueType };
    if (resolver.type === 'CONSTANT') written.value = links.constantValue ?? resolver.value ?? '';
    if (resolver.type === 'SERVICE') {
      if (!links.serviceId) throw new Error(`${name} is missing its service id.`);
      written.value = { id: links.serviceId };
    }
    return written;
  });
  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    type: 'ATTRIBUTE',
    valueType: spec.valueType,
    resolvers,
  };
  if (links.parentId) body.parent = { id: links.parentId };
  if (spec.processor) body.processor = spec.processor;
  return body;
}

export function parentAttributeBody(): Record<string, unknown> {
  return attributeBody(TRUST_PARENT);
}

export function requestAttributeBody(parentId: string, name: string, valueType: string): Record<string, unknown> {
  const body = attributeBody(name, { parentId });
  const spec = attributeSpec(name);
  if (spec.valueType.type !== valueType) throw new Error(`${name} valueType is ${spec.valueType.type}, not ${valueType}.`);
  return body;
}

export function definitionBody(parentId: string, name: string, secret: boolean): Record<string, unknown> {
  const spec = attributeSpec(name);
  const constant = spec.resolvers[0];
  if (constant?.type !== 'CONSTANT' || constant.value !== '' || spec.valueType.type !== 'STRING') {
    throw new Error(`${name} is not an empty STRING Definition.`);
  }
  if (secret !== (name === CLIENT_SECRET_DEFINITION)) throw new Error(`${name} secret flag does not match the spec.`);
  return attributeBody(name, { parentId });
}

/** Skill timeout is 3000ms, which is also PingOne's maximum. Concurrency and rate are required and are not in the skill sample. */
export const SERVICE_LIMITS = {
  maximumConcurrentRequests: 20,
  maximumRequestsPerSecond: 10,
  timeoutMilliseconds: 3000,
} as const;

export function serviceBody(name: string, url: string, tokenAttributeId: string, clientIdDefinitionId: string, secretDefinitionId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name,
    description: 'RFC 7662 introspection. Basic auth uses Trust Framework Definitions, not the OAuth resource id.',
    type: 'SERVICE',
    serviceType: 'HTTP',
    // version and fullName are generated by PingOne. cacheSettings and processor are optional.
    // channel is a CONNECTOR field, not an HTTP field.
    valueType: { type: 'JSON' },
    serviceSettings: {
      type: 'HTTP',
      url,
      verb: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: `token={{${tokenAttributeId}}}`,
      headers: [],
      maximumConcurrentRequests: SERVICE_LIMITS.maximumConcurrentRequests,
      maximumRequestsPerSecond: SERVICE_LIMITS.maximumRequestsPerSecond,
      timeoutMilliseconds: SERVICE_LIMITS.timeoutMilliseconds,
      authentication: {
        type: 'BASIC',
        name: { id: clientIdDefinitionId },
        password: { id: secretDefinitionId },
      },
      tlsSettings: { tlsValidationType: 'DEFAULT' },
    },
  };
  const error = serviceWriteError(body);
  if (error) throw new Error(error);
  return body;
}

/** User SSO introspection. PingOne accepts the access token and the SSO application client id with no Authorization header. */
export function userIntrospectionServiceBody(name: string, url: string, tokenAttributeId: string, clientIdAttributeId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name,
    description: 'SSO access-token introspection. No authentication. The form body sends the token and the SSO application client id.',
    type: 'SERVICE',
    serviceType: 'HTTP',
    valueType: { type: 'JSON' },
    serviceSettings: {
      type: 'HTTP',
      url,
      verb: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: `token={{${tokenAttributeId}}}&client_id={{${clientIdAttributeId}}}`,
      headers: [],
      maximumConcurrentRequests: SERVICE_LIMITS.maximumConcurrentRequests,
      maximumRequestsPerSecond: SERVICE_LIMITS.maximumRequestsPerSecond,
      timeoutMilliseconds: SERVICE_LIMITS.timeoutMilliseconds,
      authentication: { type: 'NONE' },
      tlsSettings: { tlsValidationType: 'DEFAULT' },
    },
  };
  const error = serviceWriteError(body);
  if (error) throw new Error(error);
  return body;
}

export function serviceWriteError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'INVALID_DATA service body is missing.';
  const record = body as {
    type?: unknown;
    serviceType?: unknown;
    parent?: unknown;
    valueType?: { type?: unknown };
    serviceSettings?: {
      type?: unknown;
      url?: unknown;
      verb?: unknown;
      contentType?: unknown;
      body?: unknown;
      headers?: unknown;
      maximumConcurrentRequests?: unknown;
      maximumRequestsPerSecond?: unknown;
      timeoutMilliseconds?: unknown;
      channel?: unknown;
      authentication?: { type?: unknown; name?: { id?: unknown }; password?: { id?: unknown } };
      tlsSettings?: { tlsValidationType?: unknown };
    };
  };
  if (record.type !== 'SERVICE') return 'INVALID_DATA type must be SERVICE.';
  if (record.serviceType !== 'HTTP') return 'INVALID_DATA serviceType must be HTTP.';
  if (record.parent) return 'INVALID_DATA HTTP introspection services are top-level.';
  if (record.valueType?.type !== 'JSON') return 'INVALID_DATA valueType must be JSON.';
  const settings = record.serviceSettings;
  if (!settings) return 'INVALID_DATA serviceSettings is required.';
  if (settings.channel) return 'INVALID_DATA channel is only valid on a CONNECTOR service.';
  if (settings.type !== 'HTTP') return 'INVALID_DATA serviceSettings.type must be HTTP.';
  if (typeof settings.url !== 'string' || !settings.url) return 'INVALID_DATA serviceSettings.url is required.';
  if (settings.verb !== 'POST') return 'INVALID_DATA serviceSettings.verb must be POST.';
  if (settings.contentType !== 'application/x-www-form-urlencoded') return 'INVALID_DATA serviceSettings.contentType is required.';
  if (!Array.isArray(settings.headers)) return 'INVALID_DATA serviceSettings.headers must be an array.';
  if (!integerInRange(settings.maximumConcurrentRequests, 1, Number.MAX_SAFE_INTEGER)) {
    return 'INVALID_DATA OUT_OF_RANGE serviceSettings.maximumConcurrentRequests must be between 1 and 9223372036854775807.';
  }
  if (typeof settings.maximumRequestsPerSecond !== 'number' || !(settings.maximumRequestsPerSecond > 0)) {
    return 'INVALID_DATA OUT_OF_RANGE serviceSettings.maximumRequestsPerSecond must be greater than 0.';
  }
  if (!integerInRange(settings.timeoutMilliseconds, 0, 3000)) {
    return 'INVALID_DATA OUT_OF_RANGE serviceSettings.timeoutMilliseconds must be between 0 and 3000.';
  }
  const requestError = introspectionRequestError(settings);
  if (requestError) return requestError;
  if (settings.tlsSettings?.tlsValidationType !== 'DEFAULT') return 'INVALID_DATA serviceSettings.tlsSettings.tlsValidationType must be DEFAULT.';
  return null;
}

export function serviceAttributeBody(parentId: string, name: string, serviceId: string, path: string): Record<string, unknown> {
  const spec = attributeSpec(name);
  if (spec.processor?.expression !== path) throw new Error(`${name} JSONPath is ${String(spec.processor?.expression)}.`);
  return attributeBody(name, { parentId, serviceId });
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
    type: 'EMBEDDED_STATEMENT',
    name: FEATURE_STATEMENT,
    description: 'Static feature flags for the desktop client. The payload does not interpolate attributes.',
    code: FEATURE_STATEMENT,
    obligatory: true,
    appliesTo: plan.effect === 'DENY' ? 'DENY' : 'PERMIT',
    appliesIf: 'PATH_MATCHES',
    attributes: [],
    services: [],
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
    statements: [],
    children: [],
  };
}

export function decisionEndpointBody(): Record<string, unknown> {
  return {
    name: DECISION_ENDPOINT,
    description: 'Enterprise Agent decision endpoint.',
    recordRecentRequests: true,
  };
}

export function decisionEndpointUpdate(
  current: { id: string; name?: unknown; description?: unknown; recordRecentRequests?: unknown },
  versionId?: string,
  policyId?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: current.id,
    name: typeof current.name === 'string' ? current.name : DECISION_ENDPOINT,
    description: typeof current.description === 'string' ? current.description : 'Enterprise Agent decision endpoint.',
    recordRecentRequests: current.recordRecentRequests !== false,
  };
  if (policyId) body.policy = { id: policyId };
  if (versionId) body.authorizationVersion = { id: versionId };
  return body;
}

export function tagBody(): Record<string, unknown> {
  return { description: 'Enterprise Agent scaffold' };
}

/** Shown on Scaffold confirm and dry run. The client id is the SSO login application, not a secret. */
export function introspectionNote(clientId: string): string {
  const id = clientId.trim() || '(not set)';
  return `User SSO introspection has no authentication. The form body is token and client_id. client_id is ${id}, the SSO login application from tenant.clientId, stored on ${USER_CLIENT_ID_DEFINITION}. Delegation introspection keeps BASIC auth on ${CLIENT_ID_DEFINITION} and ${CLIENT_SECRET_DEFINITION}, the enterprise agent client used for token exchange.`;
}

function introspectionRequestError(settings: {
  body?: unknown;
  authentication?: { type?: unknown; name?: unknown; password?: unknown };
}): string | null {
  const auth = settings.authentication;
  const body = settings.body;
  if (auth?.type === 'NONE') {
    if (auth.name != null || auth.password != null) return 'INVALID_DATA NONE authentication must not include name or password.';
    if (typeof body !== 'string' || !/^token=\{\{[^}]+\}\}&client_id=\{\{[^}]+\}\}$/.test(body)) {
      return 'INVALID_DATA unauthenticated introspection body must be token={{attribute-id}}&client_id={{attribute-id}}.';
    }
    return null;
  }
  if (auth?.type !== 'BASIC') return 'INVALID_DATA serviceSettings.authentication must be BASIC or NONE.';
  const basic = auth as { name?: { id?: unknown }; password?: { id?: unknown } };
  if (typeof basic.name?.id !== 'string' || !basic.name.id || typeof basic.password?.id !== 'string' || !basic.password.id) {
    return 'INVALID_DATA BASIC authentication must point at Definition ids.';
  }
  if (typeof body !== 'string' || !/^token=\{\{[^}]+\}\}$/.test(body)) return 'INVALID_DATA BASIC introspection body must be token={{attribute-id}}.';
  return null;
}

function integerInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function policyWriteError(body: unknown, writing: boolean): string | null {
  if (!body || typeof body !== 'object') return 'INVALID_DATA policy body is missing.';
  const record = body as { type?: unknown; name?: unknown; id?: unknown; version?: unknown; combiningAlgorithm?: { algorithm?: unknown }; enabled?: unknown; children?: unknown };
  if (record.type !== 'POLICY') return 'INVALID_DATA policy type must be POLICY.';
  if (typeof record.name !== 'string' || !record.name) return 'INVALID_DATA policy name is required.';
  const algorithm = record.combiningAlgorithm?.algorithm;
  if (algorithm !== 'DENY_OVERRIDES' && algorithm !== 'FIRST_APPLICABLE') return 'INVALID_DATA combiningAlgorithm.algorithm is required.';
  if (typeof record.enabled !== 'boolean') return 'INVALID_DATA policy enabled must be boolean.';
  if (writing && (typeof record.id !== 'string' || !record.id || typeof record.version !== 'string' || !record.version)) {
    return 'INVALID_DATA policy id and version are required on PUT.';
  }
  if (!Array.isArray(record.children)) return 'INVALID_DATA policy children must be an array.';
  for (const child of record.children) {
    const error = childWriteError(child);
    if (error) return error;
  }
  return null;
}

function childWriteError(child: unknown): string | null {
  if (!child || typeof child !== 'object') return 'INVALID_DATA policy child is missing.';
  const record = child as { type?: unknown; effectSettings?: { type?: unknown }; combiningAlgorithm?: unknown };
  if (record.type === 'RULE' || record.effectSettings) return ruleWriteError(child);
  if (record.type === 'POLICY' && isPolicyReference(record)) return null;
  if (record.type === 'POLICY' || record.combiningAlgorithm) return policyWriteError(child, false);
  return 'INVALID_DATA policy child type must be POLICY or RULE.';
}

function isPolicyReference(record: { value?: { id?: unknown }; name?: unknown; combiningAlgorithm?: unknown }): boolean {
  const id = record.value?.id;
  return typeof id === 'string' && id.length > 0 && !record.name && !record.combiningAlgorithm;
}

/** The create body for Enterprise Agent Features. New inline policies and rules omit id and version. */
export function featurePolicyTree(attributeIds: Map<string, string>, adminGroup: string, delegations: DelegationGrant[]): Record<string, unknown> {
  return {
    type: 'POLICY',
    name: ROOT_POLICY,
    description: 'Denies the Enterprise Agent decision when the user policy or the delegation policy denies.',
    enabled: true,
    combiningAlgorithm: { algorithm: 'DENY_OVERRIDES' },
    children: [
      {
        ...inlinePolicyChild(
          USER_POLICY,
          'User policy. The SSO access token is introspected for groups and active, and Protect risk is supplied by the client.',
        ),
        children: userRulePlans(adminGroup).map((plan) => ruleBody(plan, attributeIds)),
      },
      {
        ...inlinePolicyChild(
          DELEGATION_POLICY,
          'Delegation policy. The token-exchanged token is introspected as EnterpriseAgent.tx-token. Approval claims are omitted until human-in-the-loop approval lands.',
        ),
        children: delegationRulePlans(delegations).map((plan) => ruleBody(plan, attributeIds)),
      },
    ],
  };
}

export interface PolicyChildSummary {
  type: string;
  name: string;
  id: string;
  valueId: string;
}

export function summarizePolicyChildren(body: unknown): PolicyChildSummary[] {
  const children = (body as { children?: unknown } | null)?.children;
  if (!Array.isArray(children)) return [];
  return children.map((child) => {
    const record = child && typeof child === 'object' ? (child as Record<string, unknown>) : {};
    const value = record.value && typeof record.value === 'object' ? (record.value as { id?: unknown }) : {};
    return {
      type: typeof record.type === 'string' ? record.type : '',
      name: typeof record.name === 'string' ? record.name : '',
      id: typeof record.id === 'string' ? record.id : '',
      valueId: typeof value.id === 'string' ? value.id : '',
    };
  });
}

/** Same walk as scripts/walk_policy_tree.py: id, name, type, and readOnly, then each embedded child. */
export function walkPolicyTree(node: unknown, depth = 0): string[] {
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  const id = typeof record.id === 'string' && record.id ? record.id : '<no-id>';
  const name = typeof record.name === 'string' && record.name ? record.name : '<unnamed>';
  const type = typeof record.type === 'string' && record.type ? `  (${record.type})` : '';
  const managed = record.managedEntity as { restrictions?: { readOnly?: boolean } } | undefined;
  const marker = managed?.restrictions?.readOnly ? ' [readOnly]' : '';
  const lines = [`${'  '.repeat(depth)}${id}  ${name}${type}${marker}`];
  const children = Array.isArray(record.children) ? record.children : [];
  for (const child of children) lines.push(...walkPolicyTree(child, depth + 1));
  return lines;
}

/** A new child policy inside a parent PUT. PingOne assigns the id. An existing policy's id does not move it. */
export function inlinePolicyChild(name: string, description: string): Record<string, unknown> {
  return {
    type: 'POLICY',
    name,
    description,
    combiningAlgorithm: { algorithm: 'FIRST_APPLICABLE' },
    enabled: true,
    children: [],
  };
}

/**
 * What a parent GET returns after a policy POST that included inline children.
 * An inline child with no id is created and referenced. A full copy of an existing policy is not attached.
 * Rules stay embedded on that child. The read API has no expand parameter.
 */
export function recordedPolicyChildren(
  children: unknown,
  knownIds: ReadonlySet<string>,
  allocateId: () => string,
  save: (id: string, body: Record<string, unknown>) => void,
): unknown[] {
  if (!Array.isArray(children)) return [];
  const recorded: unknown[] = [];
  for (const child of children) {
    if (!child || typeof child !== 'object') continue;
    const record = child as Record<string, unknown>;
    if (record.type === 'RULE' || record.effectSettings) {
      recorded.push(record);
      continue;
    }
    const referenced = (record.value as { id?: unknown } | undefined)?.id;
    if (record.type === 'POLICY' && typeof referenced === 'string' && referenced && !record.name) {
      recorded.push({ type: 'POLICY', value: { id: referenced } });
      continue;
    }
    const existingId = typeof record.id === 'string' ? record.id : '';
    if (existingId && knownIds.has(existingId)) continue;
    if (record.type !== 'POLICY' || typeof record.name !== 'string' || !record.name) continue;
    const id = allocateId();
    save(id, { ...record, id, version: 'v1', children: Array.isArray(record.children) ? record.children : [] });
    recorded.push({ type: 'POLICY', value: { id } });
  }
  return recorded;
}

/**
 * Create accepts inline children. A policy PUT does not.
 * Live read-back of a PUT that sent children kept `children: []` and the same version.
 * The create example is the request that includes inline policies and rules.
 */
export function applyPolicyWrite(
  method: 'POST' | 'PUT',
  prior: Record<string, unknown> | undefined,
  body: Record<string, unknown> | undefined,
  id: string,
  knownIds: ReadonlySet<string>,
  allocateId: () => string,
  saveChild: (childId: string, child: Record<string, unknown>) => void,
): Record<string, unknown> {
  const incoming = body ?? {};
  if (method === 'PUT') {
    const version = typeof prior?.version === 'string' && prior.version ? prior.version : 'v1';
    const children = Array.isArray(prior?.children) ? prior.children : [];
    return { ...(prior ?? {}), ...incoming, id, version, children };
  }
  const created: Record<string, unknown> = { ...(prior ?? {}), ...incoming, id, version: 'v1' };
  created.children = recordedPolicyChildren(incoming.children, knownIds, allocateId, saveChild);
  return created;
}

function ruleWriteError(child: unknown): string | null {
  const rule = child as {
    type?: unknown;
    name?: unknown;
    enabled?: unknown;
    effectSettings?: { type?: unknown };
    condition?: unknown;
    statements?: unknown;
  };
  if (rule.type !== 'RULE') return 'INVALID_DATA rule type must be RULE.';
  if (typeof rule.name !== 'string' || !rule.name) return 'INVALID_DATA rule name is required.';
  if (rule.enabled !== true) return 'INVALID_DATA rule enabled must be true.';
  if (rule.effectSettings?.type !== 'UNCONDITIONAL_PERMIT' && rule.effectSettings?.type !== 'UNCONDITIONAL_DENY') {
    return 'INVALID_DATA effectSettings.type must be UNCONDITIONAL_PERMIT or UNCONDITIONAL_DENY.';
  }
  const conditionError = conditionWriteError(rule.condition);
  if (conditionError) return conditionError;
  if (!Array.isArray(rule.statements) || rule.statements.length === 0) return 'INVALID_DATA rule statements are required.';
  for (const statement of rule.statements) {
    const error = statementWriteError(statement);
    if (error) return error;
  }
  return null;
}

function statementWriteError(statement: unknown): string | null {
  if (!statement || typeof statement !== 'object') return 'INVALID_DATA statement is missing.';
  const record = statement as {
    type?: unknown;
    name?: unknown;
    code?: unknown;
    obligatory?: unknown;
    appliesTo?: unknown;
    appliesIf?: unknown;
    attributes?: unknown;
    services?: unknown;
    payload?: unknown;
  };
  if (record.type !== 'EMBEDDED_STATEMENT') return 'INVALID_DATA statement type must be EMBEDDED_STATEMENT.';
  if (typeof record.name !== 'string' || !record.name) return 'INVALID_DATA statement name is required.';
  if (typeof record.code !== 'string' || !record.code) return 'INVALID_DATA statement code is required.';
  if (typeof record.obligatory !== 'boolean') return 'INVALID_DATA statement obligatory must be boolean.';
  if (record.appliesTo !== 'PERMIT' && record.appliesTo !== 'DENY' && record.appliesTo !== 'PERMIT_OR_DENY') {
    return 'INVALID_DATA statement appliesTo is required.';
  }
  if (record.appliesIf !== 'PATH_MATCHES' && record.appliesIf !== 'FINAL_DECISION_MATCHES') return 'INVALID_DATA statement appliesIf is required.';
  if (!Array.isArray(record.attributes)) return 'INVALID_DATA statement attributes must be an array.';
  if (!Array.isArray(record.services)) return 'INVALID_DATA statement services must be an array.';
  if (typeof record.payload !== 'string') return 'INVALID_DATA statement payload must be a string.';
  return null;
}

export function decisionEndpointCreateError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'INVALID_DATA decision endpoint body is missing.';
  const record = body as { name?: unknown; description?: unknown; recordRecentRequests?: unknown; policyId?: unknown };
  if (typeof record.name !== 'string' || !record.name) return 'INVALID_DATA decision endpoint name is required.';
  if (typeof record.description !== 'string' || !record.description) return 'INVALID_DATA decision endpoint description is required.';
  if (typeof record.recordRecentRequests !== 'boolean') return 'INVALID_DATA recordRecentRequests is required.';
  if (record.policyId) return 'INVALID_DATA policyId is not attached; use authorizationVersion.id.';
  return null;
}

export function decisionEndpointUpdateError(body: unknown): string | null {
  const created = decisionEndpointCreateError(body);
  if (created) return created;
  const record = body as { id?: unknown; authorizationVersion?: { id?: unknown } };
  if (typeof record.id !== 'string' || !record.id) return 'INVALID_DATA decision endpoint id is required on PUT.';
  if (record.authorizationVersion && (typeof record.authorizationVersion.id !== 'string' || !record.authorizationVersion.id)) {
    return 'INVALID_DATA authorizationVersion.id is required when attaching a version.';
  }
  return null;
}

export function tagWriteError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'INVALID_DATA authorization version tag body is missing.';
  const description = (body as { description?: unknown }).description;
  if (typeof description !== 'string' || !description) return 'INVALID_DATA authorization version tag description is required.';
  return null;
}

function conditionWriteError(condition: unknown): string | null {
  if (!condition || typeof condition !== 'object') return 'INVALID_DATA rule condition is required.';
  const record = condition as {
    type?: unknown;
    conditions?: unknown;
    left?: { type?: unknown; id?: unknown };
    comparator?: unknown;
    right?: { type?: unknown; value?: unknown };
  };
  if (record.type === 'AND' || record.type === 'OR') {
    if (!Array.isArray(record.conditions) || record.conditions.length === 0) return 'INVALID_DATA compound condition needs conditions.';
    for (const child of record.conditions) {
      const error = conditionWriteError(child);
      if (error) return error;
    }
    return null;
  }
  if (record.type !== 'COMPARISON') return 'INVALID_DATA condition type must be AND, OR, or COMPARISON.';
  if (record.left?.type !== 'ATTRIBUTE' || typeof record.left.id !== 'string' || !record.left.id) {
    return 'INVALID_DATA comparison left must be an attribute id.';
  }
  if (record.comparator !== 'EQUALS' && record.comparator !== 'NOT_EQUALS' && record.comparator !== 'CONTAINS') {
    return 'INVALID_DATA comparison comparator is required.';
  }
  if (record.right?.type !== 'CONSTANT' || typeof record.right.value !== 'string') {
    return 'INVALID_DATA comparison right must be a constant string.';
  }
  return null;
}

export function attributeWriteError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'INVALID_DATA attribute body is missing.';
  const record = body as {
    name?: unknown;
    type?: unknown;
    valueType?: { type?: unknown };
    parent?: { id?: unknown };
    resolvers?: unknown;
    processor?: { type?: unknown; name?: unknown; expression?: unknown; valueType?: { type?: unknown } };
  };
  if (typeof record.name !== 'string' || !record.name) return 'INVALID_DATA attribute name is required.';
  if (record.type !== 'ATTRIBUTE') return 'INVALID_DATA attribute type must be ATTRIBUTE.';
  if (typeof record.valueType?.type !== 'string' || !record.valueType.type) return 'INVALID_DATA attribute valueType is required.';
  if (!Array.isArray(record.resolvers) || record.resolvers.length === 0) return 'INVALID_DATA attribute resolvers are required.';
  for (const resolver of record.resolvers) {
    const error = resolverWriteError(resolver);
    if (error) return error;
  }
  const service = record.resolvers.some((resolver) => (resolver as { type?: unknown }).type === 'SERVICE');
  if (service && !record.processor) return 'INVALID_DATA a SERVICE attribute needs a JSON_PATH processor.';
  if (!service && record.processor) return 'INVALID_DATA only a SERVICE attribute has a processor.';
  if (record.processor) {
    const processor = record.processor;
    if (typeof processor.name !== 'string' || !processor.name) return 'INVALID_DATA EMPTY_VALUE processor.name must not be null.';
    if (processor.type !== 'JSON_PATH') return 'INVALID_DATA processor.type must be JSON_PATH.';
    if (typeof processor.expression !== 'string' || !processor.expression.startsWith('$.')) return 'INVALID_DATA processor.expression is required.';
    if (typeof processor.valueType?.type !== 'string' || !processor.valueType.type) return 'INVALID_DATA processor.valueType is required.';
  }
  if (record.parent && (typeof record.parent.id !== 'string' || !record.parent.id)) return 'INVALID_DATA parent.id is required when parent is set.';
  return null;
}

function resolverWriteError(resolver: unknown): string | null {
  if (!resolver || typeof resolver !== 'object') return 'INVALID_DATA resolver is missing.';
  const record = resolver as { type?: unknown; valueType?: { type?: unknown }; value?: unknown; processor?: unknown };
  if (record.processor) return 'INVALID_DATA resolvers do not carry a processor. Put it on the attribute.';
  if (typeof record.valueType?.type !== 'string' || !record.valueType.type) return 'INVALID_DATA resolver valueType must not be null.';
  if (record.type === 'REQUEST') return null;
  if (record.type === 'CONSTANT') {
    if (typeof record.value !== 'string') return 'INVALID_DATA constant resolver value is required.';
    return null;
  }
  if (record.type === 'SERVICE') {
    const id = (record.value as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'string' || !id) return 'INVALID_DATA SERVICE resolver value.id is required.';
    return null;
  }
  return 'INVALID_DATA resolver type must be REQUEST, CONSTANT, or SERVICE.';
}

export function authorizeWriteError(url: string, method: string, body: unknown): string | null {
  if (url.includes('/authorizationAttributes') && (method === 'POST' || method === 'PUT')) return attributeWriteError(body);
  if (url.includes('/authorizationServices') && (method === 'POST' || method === 'PUT')) return serviceWriteError(body);
  if (url.includes('/authorizationPolicies') && method === 'PUT') return policyWriteError(body, true);
  if (url.includes('/decisionEndpoints') && !url.endsWith('/tag') && method === 'POST') return decisionEndpointCreateError(body);
  if (url.includes('/decisionEndpoints') && method === 'PUT') return decisionEndpointUpdateError(body);
  if (url.endsWith('/tag') && method === 'PUT') return tagWriteError(body);
  return null;
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
