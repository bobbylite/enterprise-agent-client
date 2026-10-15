import type { EnterpriseConfig } from '../config';
import type { AuthorizePolicy } from './policy';
import { AuthorizeClient } from './remote';
import {
  CLIENT_ID_DEFINITION,
  CLIENT_SECRET_DEFINITION,
  DECISION_ENDPOINT,
  DELEGATION_POLICY,
  DELEGATION_SERVICE,
  ROOT_POLICY,
  TRUST_PARENT,
  USER_POLICY,
  USER_SERVICE,
  attributeBody,
  decisionEndpointBody,
  decisionEndpointUpdate,
  delegationRulePlans,
  inlinePolicyChild,
  introspectUrl,
  policyShell,
  ruleBody,
  ruleSetHash,
  scaffoldPlan,
  serviceBody,
  tagBody,
  userRulePlans,
  writablePolicy,
  type DelegationGrant,
  type RulePlan,
} from './framework';

export interface TfRecord {
  remoteId: string;
  contentHash: string;
}

export interface TfStore {
  get(kind: string, name: string): TfRecord | null;
  put(kind: string, name: string, remoteId: string, contentHash: string): void;
}

export interface ProvisionInput {
  config: EnterpriseConfig;
  accessToken: string;
  client: AuthorizeClient;
  store: TfStore;
  adminGroup: string;
  delegations: DelegationGrant[];
  alwaysCurrent: boolean;
  shouldContinue?: () => boolean;
}

export interface ProvisionResult {
  decisionEndpointId: string;
  policies: AuthorizePolicy[];
}

interface Resource extends Record<string, unknown> {
  id: string;
  name?: string;
  version?: string;
}

export async function provisionAuthorize(input: ProvisionInput): Promise<ProvisionResult> {
  const api = apiBase(input.config);
  const headers = {
    Authorization: `Bearer ${input.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const going = () => input.shouldContinue?.() !== false;

  const plan = scaffoldPlan(input.config);
  const parent = await ensureResource(input, `${api}/authorizationAttributes`, 'attribute', TRUST_PARENT, attributeBody(TRUST_PARENT), headers, going);
  assertParent(parent);

  const requestIds = new Map<string, string>();
  for (const attribute of plan.attributes.filter((item) => item.resolvers[0]?.type === 'REQUEST')) {
    if (!going()) return abandoned(input);
    const saved = await ensureResource(
      input,
      `${api}/authorizationAttributes`,
      'attribute',
      attribute.name,
      attributeBody(attribute.name, { parentId: parent.id }),
      headers,
      going,
    );
    assertRequestAttribute(saved, attribute.valueType.type, parent.id);
    requestIds.set(attribute.name, saved.id);
  }

  const clientId = await ensureResource(
    input,
    `${api}/authorizationAttributes`,
    'attribute',
    CLIENT_ID_DEFINITION,
    attributeBody(CLIENT_ID_DEFINITION, { parentId: parent.id }),
    headers,
    going,
  );
  const secret = await ensureResource(
    input,
    `${api}/authorizationAttributes`,
    'attribute',
    CLIENT_SECRET_DEFINITION,
    attributeBody(CLIENT_SECRET_DEFINITION, { parentId: parent.id }),
    headers,
    going,
  );
  assertDefinition(clientId, parent.id);
  assertDefinition(secret, parent.id);

  const url = plan.services[0]?.url || introspectUrl(input.config);
  const accessId = requiredId(requestIds, 'access-token');
  const txId = requiredId(requestIds, 'tx-token');
  const userService = await ensureResource(
    input,
    `${api}/authorizationServices`,
    'service',
    USER_SERVICE,
    serviceBody(USER_SERVICE, url, accessId, clientId.id, secret.id),
    headers,
    going,
  );
  const delegationService = await ensureResource(
    input,
    `${api}/authorizationServices`,
    'service',
    DELEGATION_SERVICE,
    serviceBody(DELEGATION_SERVICE, url, txId, clientId.id, secret.id),
    headers,
    going,
  );
  assertService(userService, accessId, clientId.id, secret.id);
  assertService(delegationService, txId, clientId.id, secret.id);

  const serviceIds = new Map<string, string>([
    [USER_SERVICE, userService.id],
    [DELEGATION_SERVICE, delegationService.id],
  ]);
  const attributeIds = new Map(requestIds);
  for (const attribute of plan.attributes.filter((item) => item.resolvers[0]?.type === 'SERVICE')) {
    if (!going()) return abandoned(input);
    const serviceName = attribute.resolvers[0]?.service ?? '';
    const serviceId = requiredId(serviceIds, serviceName);
    const path = attribute.processor?.expression ?? '';
    const saved = await ensureResource(
      input,
      `${api}/authorizationAttributes`,
      'attribute',
      attribute.name,
      attributeBody(attribute.name, { parentId: parent.id, serviceId }),
      headers,
      going,
    );
    assertServiceAttribute(saved, serviceId, path, parent.id);
    attributeIds.set(attribute.name, saved.id);
  }

  const root = await ensureResource(
    input,
    `${api}/authorizationPolicies`,
    'policy',
    ROOT_POLICY,
    policyShell(ROOT_POLICY, 'Denies the Enterprise Agent decision when the user policy or the delegation policy denies.', 'DENY_OVERRIDES'),
    headers,
    going,
  );
  const userPlans = userRulePlans(input.adminGroup);
  const delegationPlans = delegationRulePlans(input.delegations);
  if (!going()) return abandoned(input);
  const nested = await nestChildren(input, api, headers, root, going);
  if (!nested) return abandoned(input);
  const userWithRules = await putRules(input, api, headers, nested.user, userPlans, attributeIds, going);
  const delegationWithRules = await putRules(input, api, headers, nested.delegation, delegationPlans, attributeIds, going);
  if (!going()) return abandoned(input);
  await assertNested(input, api, headers, root.id);

  const endpoint = await ensureDecisionEndpoint(input, api, headers, going);
  return {
    decisionEndpointId: endpoint.id,
    policies: [libraryPolicy(root, ROOT_POLICY), libraryPolicy(userWithRules, USER_POLICY), libraryPolicy(delegationWithRules, DELEGATION_POLICY)],
  };
}

async function putRules(
  input: ProvisionInput,
  api: string,
  headers: Record<string, string>,
  policy: Resource,
  plans: RulePlan[],
  attributeIds: Map<string, string>,
  going: () => boolean,
): Promise<Resource> {
  const hash = ruleSetHash(plans);
  const saved = input.store.get('policy-rules', policy.name ?? '');
  const current = await readResource(input, `${api}/authorizationPolicies/${policy.id}`, headers);
  if (saved?.contentHash === hash && saved.remoteId === policy.id) {
    assertRulePayloads(current, plans, attributeIds);
    return current;
  }
  if (!going()) return current;
  const existing = new Map(childrenOf(current).map((child) => [String(child.name ?? ''), child]));
  const rules = plans.map((plan) => {
    const prior = existing.get(plan.name);
    const version = typeof prior?.version === 'string' ? prior.version : '';
    const id = typeof prior?.id === 'string' ? prior.id : '';
    return ruleBody(plan, attributeIds, id && version ? { id, version } : undefined);
  });
  const written = await writePolicy(input, api, headers, writablePolicy(current, rules));
  assertRulePayloads(written, plans, attributeIds);
  input.store.put('policy-rules', policy.name ?? '', policy.id, hash);
  return written;
}

const CHILD_POLICIES = [
  {
    name: USER_POLICY,
    description: 'User policy. The SSO access token is introspected for groups and active, and Protect risk is supplied by the client.',
  },
  {
    name: DELEGATION_POLICY,
    description:
      'Delegation policy. The token-exchanged token is introspected as EnterpriseAgent.tx-token. Approval claims are omitted until human-in-the-loop approval lands.',
  },
] as const;

async function nestChildren(
  input: ProvisionInput,
  api: string,
  headers: Record<string, string>,
  root: Resource,
  going: () => boolean,
): Promise<{ user: Resource; delegation: Resource } | null> {
  const current = await readResource(input, `${api}/authorizationPolicies/${root.id}`, headers);
  const present = await resolvePolicyChildren(input, api, headers, current);
  if (nestedReady(current, present)) return requiredChildren(present);
  if (!going()) return null;
  const keep = new Set(present.map((child) => child.id));
  await deleteOrphanPolicies(input, api, headers, keep, root.id);
  const fresh = await readResource(input, `${api}/authorizationPolicies/${root.id}`, headers);
  const retained = await resolvePolicyChildren(input, api, headers, fresh);
  const retainedNames = new Set(retained.map((child) => child.name));
  const inline = CHILD_POLICIES.filter((child) => !retainedNames.has(child.name)).map((child) => inlinePolicyChild(child.name, child.description));
  const references = retained.map((child) => ({ type: 'POLICY', value: { id: child.id } }));
  const body = writablePolicy(fresh, [...references, ...inline]);
  body.combiningAlgorithm = { algorithm: 'DENY_OVERRIDES' };
  const written = await writePolicy(input, api, headers, body);
  const created = await resolvePolicyChildren(input, api, headers, written);
  if (!nestedReady(written, created)) throw new Error('PingOne did not keep the user and delegation policies under the parent.');
  return requiredChildren(created);
}

async function assertNested(input: ProvisionInput, api: string, headers: Record<string, string>, rootId: string): Promise<void> {
  const read = await readResource(input, `${api}/authorizationPolicies/${rootId}`, headers);
  const children = await resolvePolicyChildren(input, api, headers, read);
  if (!nestedReady(read, children)) throw new Error('PingOne did not keep the user and delegation policies under the parent.');
}

function nestedReady(parent: Resource, children: Resource[]): boolean {
  const names = new Set(children.map((child) => child.name));
  const algorithm = (parent.combiningAlgorithm as { algorithm?: string } | undefined)?.algorithm;
  return names.has(USER_POLICY) && names.has(DELEGATION_POLICY) && algorithm === 'DENY_OVERRIDES';
}

function requiredChildren(children: Resource[]): { user: Resource; delegation: Resource } {
  const user = children.find((child) => child.name === USER_POLICY);
  const delegation = children.find((child) => child.name === DELEGATION_POLICY);
  if (!user || !delegation) throw new Error('PingOne did not keep the user and delegation policies under the parent.');
  return { user, delegation };
}

/** A parent read may embed a child or return only `{ type, value: { id } }`. Both are the same placement. */
async function resolvePolicyChildren(input: ProvisionInput, api: string, headers: Record<string, string>, parent: Resource): Promise<Resource[]> {
  const resolved: Resource[] = [];
  for (const child of childrenOf(parent)) {
    if (child.type === 'RULE' || child.effectSettings) continue;
    const referenced = (child.value as { id?: string } | undefined)?.id;
    const id = typeof child.id === 'string' && child.id ? child.id : referenced;
    if (typeof child.name === 'string' && child.name && id && child.id === id && !referenced) {
      resolved.push(child);
      continue;
    }
    if (!id) continue;
    resolved.push(await readResource(input, `${api}/authorizationPolicies/${id}`, headers));
  }
  return resolved;
}

async function deleteOrphanPolicies(
  input: ProvisionInput,
  api: string,
  headers: Record<string, string>,
  keep: Set<string>,
  rootId: string,
): Promise<void> {
  const names = new Set<string>(CHILD_POLICIES.map((child) => child.name));
  const listed = await listResources(input, `${api}/authorizationPolicies`, 'authorizationPolicies', headers);
  for (const policy of listed) {
    if (!policy.name || !names.has(policy.name) || policy.id === rootId || keep.has(policy.id)) continue;
    const response = await input.client.request(`${api}/authorizationPolicies/${policy.id}`, { method: 'DELETE', headers });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(await errorText(response, `PingOne did not delete the orphaned policy ${policy.name}`));
    await input.client.paceAfterManagementPost();
  }
}

async function ensureDecisionEndpoint(input: ProvisionInput, api: string, headers: Record<string, string>, going: () => boolean): Promise<Resource> {
  const endpoint = await ensureResource(
    input,
    `${api}/decisionEndpoints`,
    'endpoint',
    DECISION_ENDPOINT,
    decisionEndpointBody(),
    headers,
    going,
  );
  const currentEndpoint = await readResource(input, `${api}/decisionEndpoints/${endpoint.id}`, headers);
  const already = (currentEndpoint.authorizationVersion as { id?: string } | undefined)?.id;
  if (!input.alwaysCurrent && already) return currentEndpoint;
  if (input.alwaysCurrent) {
    const current = await readResource(input, `${api}/decisionEndpoints/${endpoint.id}`, headers);
    if (current.authorizationVersion) {
      const detached = decisionEndpointUpdate(current);
      const written = await sendJson(input, `${api}/decisionEndpoints/${endpoint.id}`, 'PUT', headers, detached);
      if (written.authorizationVersion) throw new Error('PingOne kept a fixed authorization version in always-current mode.');
    }
    return endpoint;
  }
  const versionId = await latestVersionId(input, api, headers);
  await sendJson(input, `${api}/authorizationVersions/${versionId}/tag`, 'PUT', headers, tagBody());
  const tagged = await readResource(input, `${api}/authorizationVersions/${versionId}`, headers);
  if (!tagged.tag && !tagged.version) throw new Error('PingOne did not return the tagged authorization version.');
  const current = await readResource(input, `${api}/decisionEndpoints/${endpoint.id}`, headers);
  const attached = decisionEndpointUpdate(current, versionId);
  await sendJson(input, `${api}/decisionEndpoints/${endpoint.id}`, 'PUT', headers, attached);
  const read = await readResource(input, `${api}/decisionEndpoints/${endpoint.id}`, headers);
  const attachedId = (read.authorizationVersion as { id?: string } | undefined)?.id;
  if (attachedId !== versionId) throw new Error('PingOne decision endpoint did not keep the tagged authorization version.');
  return read;
}

async function latestVersionId(input: ProvisionInput, api: string, headers: Record<string, string>): Promise<string> {
  const response = await input.client.request(`${api}/authorizationVersions`, { headers });
  if (!response.ok) throw new Error(await errorText(response, 'PingOne did not list authorization versions'));
  const body = (await response.json()) as Record<string, unknown>;
  const rows = embedded(body, 'authorizationVersions');
  const latest = rows[rows.length - 1];
  if (!latest || typeof latest.id !== 'string' || !latest.id) throw new Error('PingOne did not return an authorization version to tag.');
  return latest.id;
}

async function ensureResource(
  input: ProvisionInput,
  collection: string,
  kind: string,
  name: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  going: () => boolean,
): Promise<Resource> {
  const remember = (resource: Resource, hash: string) => {
    input.store.put(kind, name, resource.id, hash);
    return resource;
  };
  const cached = input.store.get(kind, name);
  if (cached) {
    const read = await readResource(input, `${collection}/${cached.remoteId}`, headers);
    if (read.id !== cached.remoteId) throw new Error(`PingOne ${kind} ${name} id did not match the saved id.`);
    return remember(await alignFound(input, collection, headers, read, body), cached.contentHash);
  }
  const found = await findNamed(input, collection, collectionKey(collection), name, headers);
  if (found) {
    const read = await readResource(input, `${collection}/${found.id}`, headers);
    return remember(await alignFound(input, collection, headers, read, body), input.store.get('policy-rules', name)?.contentHash ?? '');
  }
  if (!going()) throw new Error('Scaffold stopped before creating PingOne resources.');
  try {
    const created = await sendJson(input, collection, 'POST', headers, body);
    await input.client.paceAfterManagementPost();
    const read = await readResource(input, `${collection}/${created.id}`, headers);
    if (read.id !== created.id) throw new Error(`PingOne ${kind} ${name} read-back id did not match the create response.`);
    if (read.name !== name) throw new Error(`PingOne ${kind} read-back name was ${String(read.name)}.`);
    return remember(read, '');
  } catch (error) {
    const recovered = await findNamed(input, collection, collectionKey(collection), name, headers);
    if (!recovered) throw error;
    const read = await readResource(input, `${collection}/${recovered.id}`, headers);
    return remember(await alignFound(input, collection, headers, read, body), '');
  }
}

/** A failed create can leave the named object in PingOne. Reuse it, and fill a resolver valueType the API now requires. */
async function alignFound(
  input: ProvisionInput,
  collection: string,
  headers: Record<string, string>,
  current: Resource,
  intended: Record<string, unknown>,
): Promise<Resource> {
  if (collection.includes('authorizationServices')) return alignService(input, collection, headers, current, intended);
  if (!collection.includes('authorizationAttributes') || (!resolversMissingValueType(current) && !processorMissingName(current))) return current;
  const version = typeof current.version === 'string' ? current.version : '';
  if (!version) throw new Error(`PingOne attribute ${String(current.name)} is missing a version, so it cannot be repaired.`);
  const resolvers = intendedResolvers(intended, current);
  const body: Record<string, unknown> = { ...intended, id: current.id, version, resolvers };
  await sendJson(input, `${collection}/${current.id}`, 'PUT', headers, body);
  await input.client.paceAfterManagementPost();
  const read = await readResource(input, `${collection}/${current.id}`, headers);
  if (read.id !== current.id) throw new Error(`PingOne attribute ${String(current.name)} read-back id did not match the repair.`);
  if (resolversMissingValueType(read)) throw new Error(`PingOne attribute ${String(current.name)} still has a resolver without valueType.`);
  if (processorMissingName(read)) throw new Error(`PingOne attribute ${String(current.name)} processor.name is still missing.`);
  return read;
}

async function alignService(
  input: ProvisionInput,
  collection: string,
  headers: Record<string, string>,
  current: Resource,
  intended: Record<string, unknown>,
): Promise<Resource> {
  if (!serviceMissingLimits(current)) return current;
  const version = typeof current.version === 'string' ? current.version : '';
  if (!version) throw new Error(`PingOne service ${String(current.name)} is missing a version, so it cannot be repaired.`);
  const body = { ...intended, id: current.id, version };
  await sendJson(input, `${collection}/${current.id}`, 'PUT', headers, body);
  await input.client.paceAfterManagementPost();
  const read = await readResource(input, `${collection}/${current.id}`, headers);
  if (read.id !== current.id) throw new Error(`PingOne service ${String(current.name)} read-back id did not match the repair.`);
  if (serviceMissingLimits(read)) throw new Error(`PingOne service ${String(current.name)} is still missing its rate limits.`);
  return read;
}

function serviceMissingLimits(resource: Resource): boolean {
  const settings = resource.serviceSettings as {
    maximumConcurrentRequests?: unknown;
    maximumRequestsPerSecond?: unknown;
    timeoutMilliseconds?: unknown;
  } | undefined;
  const concurrent = settings?.maximumConcurrentRequests;
  const rate = settings?.maximumRequestsPerSecond;
  const timeout = settings?.timeoutMilliseconds;
  return (
    typeof concurrent !== 'number' ||
    !Number.isInteger(concurrent) ||
    concurrent < 1 ||
    typeof rate !== 'number' ||
    !(rate > 0) ||
    typeof timeout !== 'number' ||
    !Number.isInteger(timeout) ||
    timeout < 0 ||
    timeout > 3000
  );
}

function processorMissingName(resource: Resource): boolean {
  const processor = resource.processor as { name?: unknown } | undefined;
  if (!processor) return false;
  return typeof processor.name !== 'string' || processor.name.length === 0;
}

function resolversMissingValueType(resource: Resource): boolean {
  const resolvers = resource.resolvers as { type?: string; valueType?: { type?: string } }[] | undefined;
  if (!Array.isArray(resolvers) || resolvers.length === 0) return false;
  // REQUEST and SERVICE reads omit resolver valueType. Only a constant that was saved without one needs a repair.
  return resolvers.some((resolver) => resolver.type === 'CONSTANT' && !resolver.valueType?.type);
}

function intendedResolvers(intended: Record<string, unknown>, current: Resource): unknown[] {
  const next = Array.isArray(intended.resolvers) ? (intended.resolvers as Record<string, unknown>[]) : [];
  const prior = Array.isArray(current.resolvers) ? (current.resolvers as { type?: string; value?: unknown }[]) : [];
  return next.map((resolver, index) => {
    const existing = prior[index];
    if (resolver.type === 'CONSTANT' && existing?.type === 'CONSTANT' && typeof existing.value === 'string' && existing.value !== '') {
      return { ...resolver, value: existing.value };
    }
    return resolver;
  });
}

async function findNamed(
  input: ProvisionInput,
  collection: string,
  key: string,
  name: string,
  headers: Record<string, string>,
): Promise<Resource | undefined> {
  const listed = await listResources(input, collection, key, headers);
  return listed.find((item) => item.name === name);
}

async function writePolicy(input: ProvisionInput, api: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<Resource> {
  const id = String(body.id);
  await sendJson(input, `${api}/authorizationPolicies/${id}`, 'PUT', headers, body);
  await input.client.paceAfterManagementPost();
  const read = await readResource(input, `${api}/authorizationPolicies/${id}`, headers);
  if (read.id !== id) throw new Error('PingOne policy read-back id did not match the PUT.');
  return read;
}

async function listResources(input: ProvisionInput, url: string, key: string, headers: Record<string, string>): Promise<Resource[]> {
  const rows: Resource[] = [];
  const seen = new Set<string>();
  let next: string | null = url;
  while (next && !seen.has(next) && seen.size < 20) {
    seen.add(next);
    const response = await input.client.request(next, { headers });
    if (!response.ok) throw new Error(await errorText(response, `PingOne did not list ${key}`));
    const body = (await response.json()) as Record<string, unknown>;
    rows.push(...embedded(body, key).filter((item): item is Resource => typeof item.id === 'string'));
    const links = body._links as { next?: { href?: unknown } } | undefined;
    next = typeof links?.next?.href === 'string' ? links.next.href : null;
  }
  return rows;
}

async function readResource(input: ProvisionInput, url: string, headers: Record<string, string>): Promise<Resource> {
  const response = await input.client.request(url, { headers });
  if (!response.ok) throw new Error(await errorText(response, 'PingOne did not return that resource'));
  const body = (await response.json()) as Resource;
  if (typeof body.id !== 'string' || !body.id) throw new Error('PingOne resource did not include an id.');
  return body;
}

async function sendJson(
  input: ProvisionInput,
  url: string,
  method: 'POST' | 'PUT',
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Resource> {
  const response = await input.client.request(url, { method, headers, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await errorText(response, `PingOne did not ${method} ${url}`));
  const parsed = (await response.json()) as Resource;
  if (method === 'POST' && (typeof parsed.id !== 'string' || !parsed.id)) throw new Error('PingOne create did not return an id.');
  return parsed.id ? parsed : { ...body, id: idFrom(url) };
}

function assertParent(resource: Resource): void {
  if (resource.parent) throw new Error('EnterpriseAgent parent attribute was created under another parent.');
  assertResolverValueType(resource, 'JSON');
}

function assertRequestAttribute(resource: Resource, valueType: string, parentId: string): void {
  const resolvers = resource.resolvers as { type?: string }[] | undefined;
  if (resolvers?.[0]?.type !== 'REQUEST') throw new Error(`${String(resource.name)} is not a REQUEST attribute.`);
  assertResolverValueType(resource, valueType);
  if (resource.processor) throw new Error(`${String(resource.name)} has a processor. REQUEST attributes must not.`);
  const actual = (resource.valueType as { type?: string } | undefined)?.type;
  if (actual !== valueType) throw new Error(`${String(resource.name)} valueType is ${String(actual)}.`);
  const parent = (resource.parent as { id?: string } | undefined)?.id;
  if (parent !== parentId) throw new Error(`${String(resource.name)} is not under EnterpriseAgent.`);
}

function assertDefinition(resource: Resource, parentId: string): void {
  const parent = (resource.parent as { id?: string } | undefined)?.id;
  if (parent !== parentId) throw new Error(`${String(resource.name)} definition is not under EnterpriseAgent.`);
  const resolver = (resource.resolvers as { type?: string }[] | undefined)?.[0];
  if (resolver?.type !== 'CONSTANT') throw new Error(`${String(resource.name)} is not a constant Definition.`);
  assertResolverValueType(resource, 'STRING');
}

function assertService(resource: Resource, tokenAttributeId: string, clientId: string, secretId: string): void {
  if (resource.parent) throw new Error(`${String(resource.name)} is not a top-level service.`);
  const settings = resource.serviceSettings as {
    authentication?: { type?: string; name?: { id?: string }; password?: { id?: string } };
    body?: string;
    timeoutMilliseconds?: number;
    maximumConcurrentRequests?: number;
    maximumRequestsPerSecond?: number;
    headers?: unknown;
    contentType?: string;
  };
  if (settings?.authentication?.type !== 'BASIC') throw new Error(`${String(resource.name)} is not BASIC auth.`);
  if (settings.authentication.name?.id !== clientId || settings.authentication.password?.id !== secretId) {
    throw new Error(`${String(resource.name)} Basic auth does not point at the Definitions.`);
  }
  if (settings.body !== `token={{${tokenAttributeId}}}`) throw new Error(`${String(resource.name)} body does not use the token attribute id.`);
  if (settings.timeoutMilliseconds !== 3000) throw new Error(`${String(resource.name)} timeout is not 3000ms.`);
  if (settings.maximumConcurrentRequests !== 20) throw new Error(`${String(resource.name)} maximumConcurrentRequests is not 20.`);
  if (settings.maximumRequestsPerSecond !== 10) throw new Error(`${String(resource.name)} maximumRequestsPerSecond is not 10.`);
  if (!Array.isArray(settings.headers)) throw new Error(`${String(resource.name)} headers were not saved.`);
  if (settings.contentType !== 'application/x-www-form-urlencoded') throw new Error(`${String(resource.name)} content type is wrong.`);
  if ((resource.valueType as { type?: string } | undefined)?.type !== 'JSON') throw new Error(`${String(resource.name)} is not JSON.`);
}

function assertServiceAttribute(resource: Resource, serviceId: string, path: string, parentId: string): void {
  const resolver = (resource.resolvers as { type?: string; value?: { id?: string } }[] | undefined)?.[0];
  if (resolver?.type !== 'SERVICE' || resolver.value?.id !== serviceId) throw new Error(`${String(resource.name)} does not use its introspection service.`);
  assertResolverValueType(resource, 'STRING');
  const processor = resource.processor as { type?: string; name?: string; expression?: string } | undefined;
  if (processor?.type !== 'JSON_PATH' || !processor.name || processor.expression !== path) {
    throw new Error(`${String(resource.name)} JSONPath is ${String(processor?.expression)}.`);
  }
  if ((resource.parent as { id?: string } | undefined)?.id !== parentId) throw new Error(`${String(resource.name)} is not under EnterpriseAgent.`);
}

function assertRulePayloads(policy: Resource, plans: RulePlan[], attributeIds: Map<string, string>): void {
  const rules = childrenOf(policy);
  for (const plan of plans) {
    const rule = rules.find((child) => child.name === plan.name);
    if (!rule) throw new Error(`PingOne policy is missing rule ${plan.name}.`);
    const statements = (rule.statements as { payload?: string; attributes?: unknown[]; code?: string }[] | undefined) ?? [];
    const statement = statements.find((item) => item.code === 'enterprise-agent-features');
    if (!statement) throw new Error(`Rule ${plan.name} is missing the features statement.`);
    if (statement.payload !== JSON.stringify(plan.payload)) throw new Error(`Rule ${plan.name} payload was not saved.`);
    if (!Array.isArray(statement.attributes) || statement.attributes.length > 0) {
      throw new Error(`Rule ${plan.name} statement attributes must stay empty.`);
    }
    const text = JSON.stringify(rule.condition ?? {});
    for (const [name, id] of attributeIds) {
      if (JSON.stringify(plan.condition).includes(`"${name}"`) && !text.includes(id)) {
        throw new Error(`Rule ${plan.name} does not reference ${name}.`);
      }
    }
  }
  if (JSON.stringify(childrenOf(policy)).includes('isApproved')) throw new Error('A rule references isApproved.');
}

function assertResolverValueType(resource: Resource, valueType: string): void {
  const resolver = (resource.resolvers as { valueType?: { type?: string } }[] | undefined)?.[0];
  const actual = resolver?.valueType?.type;
  // PingOne's GET of a REQUEST or SERVICE resolver omits valueType even when the create body sent it.
  if (!actual) return;
  if (actual !== valueType) throw new Error(`${String(resource.name)} resolver valueType is ${actual}.`);
}

function childrenOf(policy: Resource): Resource[] {
  return Array.isArray(policy.children) ? (policy.children as Resource[]) : [];
}

function embedded(body: Record<string, unknown>, key: string): Resource[] {
  const wrapped = body._embedded;
  if (wrapped && typeof wrapped === 'object') {
    const rows = (wrapped as Record<string, unknown>)[key];
    if (Array.isArray(rows)) return rows as Resource[];
  }
  const direct = body[key];
  return Array.isArray(direct) ? (direct as Resource[]) : [];
}

function collectionKey(collection: string): string {
  if (collection.includes('authorizationAttributes')) return 'authorizationAttributes';
  if (collection.includes('authorizationServices')) return 'authorizationServices';
  if (collection.includes('authorizationPolicies')) return 'authorizationPolicies';
  if (collection.includes('decisionEndpoints')) return 'decisionEndpoints';
  return 'items';
}

function requiredId(ids: Map<string, string>, name: string): string {
  const id = ids.get(name);
  if (!id) throw new Error(`Missing id for ${name}.`);
  return id;
}

function abandoned(input: ProvisionInput): ProvisionResult {
  const saved = input.store.get('endpoint', DECISION_ENDPOINT);
  return { decisionEndpointId: saved?.remoteId ?? '', policies: [] };
}

function libraryPolicy(resource: Resource, name: string): AuthorizePolicy {
  return {
    id: `enterprise-agent:pingone:${name}`,
    name,
    description: typeof resource.description === 'string' ? resource.description : name,
    enabled: resource.enabled !== false,
    updatedAt: null,
    updatedBy: null,
    scaffold: true,
    remoteId: resource.id,
    when: {},
    effect: {},
  };
}

function apiBase(config: EnterpriseConfig): string {
  return `${config.tenant.apiHost.replace(/\/$/, '')}/v1/environments/${config.tenant.environmentId}`;
}

function idFrom(url: string): string {
  const parts = url.split('/');
  return parts[parts.length - 1] ?? '';
}

async function errorText(response: Response, fallback: string): Promise<string> {
  const text = (await response.text()).trim();
  return text ? `${fallback} (${response.status}): ${text}` : `${fallback} (${response.status}).`;
}
