import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EnterpriseConfig } from '../config';
import type { AuthorizePolicy } from './policy';
import { AuthorizeClient } from './remote';
import {
  CLIENT_ID_DEFINITION,
  CLIENT_SECRET_DEFINITION,
  USER_CLIENT_ID_DEFINITION,
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
  REQUEST_ATTRIBUTES,
  SERVICE_ATTRIBUTES,
  delegationRulePlans,
  featurePolicyTree,
  introspectUrl,
  scaffoldPlan,
  serviceBody,
  userIntrospectionServiceBody,
  summarizePolicyChildren,
  tagBody,
  ruleBody,
  userRulePlans,
  walkPolicyTree,
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
  /** Write the planned tree and do not create, update, or delete anything in PingOne. */
  dryRun?: boolean;
  dryRunPath?: string;
  log?: (level: 'debug' | 'error', message: string) => void;
  logPath?: string;
}

export interface ProvisionResult {
  decisionEndpointId: string;
  policies: AuthorizePolicy[];
  dryRunPath?: string;
  /** Set when the endpoint was left always-current because no authorization version could be tagged. */
  warning?: string;
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
  if (input.dryRun) return dryRunFeaturePolicy(input, api, headers);

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

  const userClientValue = input.config.tenant.clientId.trim();
  const userClientId = await ensureResource(
    input,
    `${api}/authorizationAttributes`,
    'attribute',
    USER_CLIENT_ID_DEFINITION,
    attributeBody(USER_CLIENT_ID_DEFINITION, { parentId: parent.id, ...(userClientValue ? { constantValue: userClientValue } : {}) }),
    headers,
    going,
  );
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
  assertDefinition(userClientId, parent.id);
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
    userIntrospectionServiceBody(USER_SERVICE, url, accessId, userClientId.id),
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
  assertUserService(userService, accessId, userClientId.id);
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

  const userPlans = userRulePlans(input.adminGroup);
  const delegationPlans = delegationRulePlans(input.delegations);
  if (!going()) return abandoned(input);
  const root = await postFeatureTree(input, api, headers, attributeIds, userPlans, delegationPlans, going);
  if (!root) return abandoned(input);

  const endpoint = await ensureDecisionEndpoint(input, api, headers, going, root.parent.id);
  return {
    decisionEndpointId: endpoint.endpoint.id,
    policies: [libraryPolicy(root.parent, ROOT_POLICY), libraryPolicy(root.user, USER_POLICY), libraryPolicy(root.delegation, DELEGATION_POLICY)],
    warning: endpoint.warning,
  };
}

const MACOS_LOG = '~/Library/Logs/enterprise-agent-client/main.log';

async function dryRunFeaturePolicy(input: ProvisionInput, api: string, headers: Record<string, string>): Promise<ProvisionResult> {
  const attributeIds = new Map<string, string>();
  const listed = await listResources(input, `${api}/authorizationAttributes`, 'authorizationAttributes', headers);
  for (const attribute of listed) {
    if (attribute.name) attributeIds.set(attribute.name, attribute.id);
  }
  const body = plannedFeaturePolicy(attributeIds, input.adminGroup, input.delegations);
  const path = input.dryRunPath;
  if (!path) throw new Error('Dry run needs a file path.');
  const text = `${JSON.stringify(body, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  input.log?.('debug', `Authorize dry run wrote ${path}\n${text}`);
  return { decisionEndpointId: '', policies: [], dryRunPath: path };
}

/** Attribute ids already in PingOne are kept. Missing ones stay as `{{name}}` so the file can be read before any write. */
export function plannedFeaturePolicy(
  attributeIds: Map<string, string>,
  adminGroup: string,
  delegations: DelegationGrant[],
): Record<string, unknown> {
  const ids = new Map(attributeIds);
  for (const name of attributePlanNames()) {
    if (!ids.has(name)) ids.set(name, `{{${name}}}`);
  }
  return featurePolicyTree(ids, adminGroup, delegations);
}

function attributePlanNames(): string[] {
  return [...REQUEST_ATTRIBUTES.map((item) => item.name), ...SERVICE_ATTRIBUTES.map((item) => item.name)];
}

async function postFeatureTree(
  input: ProvisionInput,
  api: string,
  headers: Record<string, string>,
  attributeIds: Map<string, string>,
  userPlans: RulePlan[],
  delegationPlans: RulePlan[],
  going: () => boolean,
): Promise<{ parent: Resource; user: Resource; delegation: Resource } | null> {
  const collection = `${api}/authorizationPolicies`;
  const existing = await featurePolicy(input, api, headers);
  if (existing) {
    if (existing.name !== ROOT_POLICY) {
      throw new Error(`Refusing to update ${existing.name ?? existing.id}. Scaffold only writes ${ROOT_POLICY}.`);
    }
    const before = await readResource(input, `${collection}/${existing.id}`, headers);
    if (before.name !== ROOT_POLICY) {
      throw new Error(`Refusing to update ${before.name ?? before.id}. Scaffold only writes ${ROOT_POLICY}.`);
    }
    const present = await resolvePolicyChildren(input, api, headers, before);
    if (treeProblems(before, present, userPlans, delegationPlans, attributeIds).length === 0) {
      input.log?.('debug', policyTrace('Authorize policy tree already present', `${collection}/${before.id}`, null, before, present));
      return requiredChildren(before, present);
    }
    const driftedUser = userRulesOnlyDrift(before, present, userPlans, delegationPlans, attributeIds);
    if (driftedUser) {
      if (!going()) return null;
      await replaceUserRules(input, api, headers, driftedUser, userPlans, attributeIds);
      const read = await readResource(input, `${collection}/${before.id}`, headers);
      const children = await resolvePolicyChildren(input, api, headers, read);
      const problems = treeProblems(read, children, userPlans, delegationPlans, attributeIds);
      if (problems.length > 0) {
        throw new Error(`PingOne did not keep the updated ${USER_POLICY} rules. ${problems.join(' ')}`);
      }
      input.store.put('policy', ROOT_POLICY, read.id, '');
      return requiredChildren(read, children);
    }
    if (!going()) return null;
    // The name is unique, and a PUT does not add policy children. Remove only this shell, then create the tree.
    await deletePolicy(input, api, headers, before.id);
  }
  if (!going()) return null;
  const body = featurePolicyTree(attributeIds, input.adminGroup, input.delegations);
  input.log?.('debug', policyTrace('Authorize policy tree POST', collection, body, null, []));
  const created = await sendJson(input, collection, 'POST', headers, body);
  await input.client.paceAfterManagementPost();
  const url = `${collection}/${created.id}`;
  const read = await readResource(input, url, headers);
  const children = await resolvePolicyChildren(input, api, headers, read);
  const trace = policyTrace('Authorize policy tree read-back', url, body, read, children);
  input.log?.('debug', trace);
  const problems = read.name !== ROOT_POLICY ? [`Read-back was ${read.name ?? read.id}.`] : treeProblems(read, children, userPlans, delegationPlans, attributeIds);
  if (problems.length > 0) {
    input.log?.('error', trace);
    throw new Error(nestingError(read, problems, body, read, children, url, input.logPath));
  }
  input.store.put('policy', ROOT_POLICY, read.id, '');
  const verified = requiredChildren(read, children);
  await deleteOrphanPolicies(input, api, headers, new Set([verified.user.id, verified.delegation.id]), read.id);
  return verified;
}

async function deletePolicy(input: ProvisionInput, api: string, headers: Record<string, string>, id: string): Promise<void> {
  const response = await input.client.request(`${api}/authorizationPolicies/${id}`, { method: 'DELETE', headers });
  if (response.status === 404) return;
  if (!response.ok) throw new Error(await errorText(response, `PingOne did not delete policy ${id}`));
  await input.client.paceAfterManagementPost();
}

function policyTrace(
  title: string,
  url: string,
  putBody: Record<string, unknown> | null,
  getBody: Resource | null,
  resolved: Resource[],
  verb: 'POST' | 'PUT' = 'POST',
): string {
  const lines = [title, `url ${url}`];
  if (putBody) {
    lines.push(`${verb} children ${JSON.stringify(summarizePolicyChildren(putBody))}`);
    lines.push(JSON.stringify(putBody, null, 2));
  }
  if (getBody) {
    lines.push(`GET children ${JSON.stringify(summarizePolicyChildren(getBody))}`);
    lines.push(walkPolicyTree(getBody).join('\n'));
    lines.push(resolvedChildrenText(resolved));
    lines.push(JSON.stringify(getBody, null, 2));
  }
  return lines.join('\n');
}

function nestingError(
  parent: Resource,
  problems: string[],
  putBody: Record<string, unknown>,
  getBody: Resource,
  resolved: Resource[],
  url: string,
  logPath?: string,
): string {
  const missing = problems.filter((problem) => problem.startsWith('Missing policy '));
  return [
    `PingOne did not keep ${missing.map((problem) => problem.replace('Missing policy ', '')).join(' and ') || 'the policy tree'} under ${parent.name ?? ROOT_POLICY} (${parent.id}).`,
    `Missing: ${missing.join('; ') || 'none'}.`,
    ...problems.filter((problem) => !problem.startsWith('Missing policy ')),
    `Children returned: ${JSON.stringify(summarizePolicyChildren(getBody))}`,
    walkPolicyTree(getBody).join('\n'),
    resolvedChildrenText(resolved),
    `POST ${url}`,
    JSON.stringify(putBody, null, 2),
    `GET ${url}`,
    JSON.stringify(getBody, null, 2),
    `Main log: ${logPath ?? MACOS_LOG}`,
  ].join('\n');
}

function resolvedChildrenText(children: Resource[]): string {
  if (children.length === 0) return 'Resolved children: none';
  return children
    .map((child) => {
      const rules = childrenOf(child)
        .map((rule) => rule.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
      return `Resolved ${child.name ?? '<unnamed>'} id=${child.id} rules=${rules.join(', ') || 'none'}`;
    })
    .join('\n');
}

function treeProblems(
  parent: Resource,
  children: Resource[],
  userPlans: RulePlan[],
  delegationPlans: RulePlan[],
  attributeIds: Map<string, string>,
): string[] {
  const problems: string[] = [];
  const algorithm = (parent.combiningAlgorithm as { algorithm?: string } | undefined)?.algorithm;
  if (algorithm !== 'DENY_OVERRIDES') problems.push(`Combining algorithm is ${algorithm ?? 'missing'}.`);
  const user = children.find((child) => child.name === USER_POLICY);
  const delegation = children.find((child) => child.name === DELEGATION_POLICY);
  if (!user) problems.push(`Missing policy ${USER_POLICY}.`);
  if (!delegation) problems.push(`Missing policy ${DELEGATION_POLICY}.`);
  if (user) problems.push(...ruleProblems(user, userPlans, attributeIds));
  if (delegation) problems.push(...ruleProblems(delegation, delegationPlans, attributeIds));
  return problems;
}

function userRulesOnlyDrift(
  parent: Resource,
  children: Resource[],
  userPlans: RulePlan[],
  delegationPlans: RulePlan[],
  attributeIds: Map<string, string>,
): Resource | null {
  const algorithm = (parent.combiningAlgorithm as { algorithm?: string } | undefined)?.algorithm;
  if (algorithm !== 'DENY_OVERRIDES') return null;
  const user = children.find((child) => child.name === USER_POLICY);
  const delegation = children.find((child) => child.name === DELEGATION_POLICY);
  if (!user || !delegation) return null;
  if (ruleProblems(delegation, delegationPlans, attributeIds).length > 0) return null;
  if (ruleProblems(user, userPlans, attributeIds).length === 0) return null;
  return user;
}

async function replaceUserRules(
  input: ProvisionInput,
  api: string,
  headers: Record<string, string>,
  user: Resource,
  plans: RulePlan[],
  attributeIds: Map<string, string>,
): Promise<void> {
  const url = `${api}/authorizationPolicies/${user.id}`;
  const current = await readResource(input, url, headers);
  if (current.name !== USER_POLICY) throw new Error(`Refusing to update ${current.name ?? current.id}. Scaffold only rewrites ${USER_POLICY} rules in place.`);
  const children = plans.map((plan) => ruleBody(plan, attributeIds, existingRule(current, plan.name)));
  const body = writablePolicy(current, children);
  input.log?.('debug', policyTrace('Authorize user policy PUT', url, body, null, [], 'PUT'));
  await sendJson(input, url, 'PUT', headers, body);
  await input.client.paceAfterManagementPost();
}

function existingRule(policy: Resource, name: string): { id: string; version: string } | undefined {
  const rule = childrenOf(policy).find((child) => child.name === name);
  if (!rule || typeof rule.id !== 'string' || !rule.id || typeof rule.version !== 'string' || !rule.version) return undefined;
  return { id: rule.id, version: rule.version };
}

function ruleProblems(policy: Resource, plans: RulePlan[], attributeIds: Map<string, string>): string[] {
  try {
    assertRulePayloads(policy, plans, attributeIds);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function requiredChildren(parent: Resource, children: Resource[]): { parent: Resource; user: Resource; delegation: Resource } {
  const user = children.find((child) => child.name === USER_POLICY);
  const delegation = children.find((child) => child.name === DELEGATION_POLICY);
  if (!user || !delegation) {
    throw new Error(`Missing policy ${[user ? '' : USER_POLICY, delegation ? '' : DELEGATION_POLICY].filter(Boolean).join(' and ')}.`);
  }
  return { parent, user, delegation };
}

async function featurePolicy(input: ProvisionInput, api: string, headers: Record<string, string>): Promise<Resource | null> {
  const cached = input.store.get('policy', ROOT_POLICY);
  if (cached) {
    try {
      const read = await readResource(input, `${api}/authorizationPolicies/${cached.remoteId}`, headers);
      if (read.name === ROOT_POLICY) return read;
    } catch {
      // The saved id is not our policy. Find it by name instead.
    }
  }
  const found = await findNamed(input, `${api}/authorizationPolicies`, 'authorizationPolicies', ROOT_POLICY, headers);
  if (!found || found.name !== ROOT_POLICY) return null;
  return readResource(input, `${api}/authorizationPolicies/${found.id}`, headers);
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
  const names = new Set<string>([USER_POLICY, DELEGATION_POLICY]);
  const listed = await listResources(input, `${api}/authorizationPolicies`, 'authorizationPolicies', headers);
  for (const policy of listed) {
    if (!policy.name || !names.has(policy.name) || policy.id === rootId || keep.has(policy.id)) continue;
    const response = await input.client.request(`${api}/authorizationPolicies/${policy.id}`, { method: 'DELETE', headers });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(await errorText(response, `PingOne did not delete the orphaned policy ${policy.name}`));
    await input.client.paceAfterManagementPost();
  }
}

async function ensureDecisionEndpoint(
  input: ProvisionInput,
  api: string,
  headers: Record<string, string>,
  going: () => boolean,
  policyId: string,
): Promise<{ endpoint: Resource; warning?: string }> {
  const endpoint = await ensureResource(
    input,
    `${api}/decisionEndpoints`,
    'endpoint',
    DECISION_ENDPOINT,
    decisionEndpointBody(),
    headers,
    going,
  );
  if (input.alwaysCurrent) {
    const read = await writeDecisionEndpoint(input, api, headers, endpoint.id, undefined, policyId);
    return { endpoint: read };
  }
  const listed = await latestAuthorizationVersion(input, api, headers);
  if (!listed.id) return leaveAlwaysCurrent(input, api, headers, endpoint, policyId, alwaysCurrentWarning(listed.raw));
  const current = await readResource(input, `${api}/decisionEndpoints/${endpoint.id}`, headers);
  const attached = (current.authorizationVersion as { id?: string } | undefined)?.id;
  const pointed = (current.policy as { id?: string } | undefined)?.id;
  if (attached === listed.id && pointed === policyId) return { endpoint: current };
  try {
    const tagUrl = listed.tagUrl || `${api}/authorizationVersions/${listed.id}/tag`;
    await sendJson(input, tagUrl, 'PUT', headers, tagBody());
    const tagged = await readResource(input, `${api}/authorizationVersions/${listed.id}`, headers);
    if (!tagged.tag && !tagged.version) throw new Error('PingOne did not return the tagged authorization version.');
    const read = await writeDecisionEndpoint(input, api, headers, endpoint.id, listed.id, policyId);
    const attachedId = (read.authorizationVersion as { id?: string } | undefined)?.id;
    if (attachedId !== listed.id) throw new Error('PingOne decision endpoint did not keep the tagged authorization version.');
    const kept = (read.policy as { id?: string } | undefined)?.id;
    if (kept !== policyId) {
      const warning = `The decision endpoint did not keep policy ${policyId}. It returned ${kept ?? 'no policy id'}.`;
      input.log?.('error', warning);
      return { endpoint: read, warning };
    }
    return { endpoint: read };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return leaveAlwaysCurrent(input, api, headers, endpoint, policyId, `${message}\n${alwaysCurrentWarning(listed.raw)}`);
  }
}

async function leaveAlwaysCurrent(
  input: ProvisionInput,
  api: string,
  headers: Record<string, string>,
  endpoint: Resource,
  policyId: string,
  warning: string,
): Promise<{ endpoint: Resource; warning: string }> {
  input.log?.('error', warning);
  try {
    const read = await writeDecisionEndpoint(input, api, headers, endpoint.id, undefined, policyId);
    return { endpoint: read, warning };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.log?.('error', message);
    return { endpoint, warning: `${warning}\n${message}` };
  }
}

async function writeDecisionEndpoint(
  input: ProvisionInput,
  api: string,
  headers: Record<string, string>,
  endpointId: string,
  versionId: string | undefined,
  policyId: string,
): Promise<Resource> {
  const current = await readResource(input, `${api}/decisionEndpoints/${endpointId}`, headers);
  const attached = (current.authorizationVersion as { id?: string } | undefined)?.id;
  const pointed = (current.policy as { id?: string } | undefined)?.id;
  const versionMatches = versionId ? attached === versionId : !attached;
  if (versionMatches && pointed === policyId) return current;
  const body = decisionEndpointUpdate(current, versionId, policyId);
  await sendJson(input, `${api}/decisionEndpoints/${endpointId}`, 'PUT', headers, body);
  const read = await readResource(input, `${api}/decisionEndpoints/${endpointId}`, headers);
  if (versionId) return read;
  if (read.authorizationVersion) throw new Error('PingOne kept a fixed authorization version in always-current mode.');
  return read;
}

function alwaysCurrentWarning(raw: string): string {
  return `PingOne did not return an authorization version to tag. The Enterprise Agent decision endpoint is always-current, which is for development and debugging.\nVersions response: ${raw}`;
}

async function latestAuthorizationVersion(
  input: ProvisionInput,
  api: string,
  headers: Record<string, string>,
): Promise<{ id: string; tagUrl?: string; raw: string }> {
  const response = await input.client.request(`${api}/authorizationVersions?limit=25`, { headers });
  const raw = await response.text();
  if (!response.ok) return { id: '', raw };
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return { id: '', raw };
  }
  const latest = newestVersion(versionItems(body));
  if (!latest?.id) return { id: '', raw };
  const links = latest._links as { tag?: { href?: unknown } } | undefined;
  const tagUrl = typeof links?.tag?.href === 'string' ? links.tag.href : undefined;
  return { id: latest.id, tagUrl, raw };
}

/** The list example returns `_embedded.items`, newest `createdAt` first. */
function versionItems(body: unknown): Resource[] {
  if (!body || typeof body !== 'object') return [];
  const embeddedBlock = (body as { _embedded?: Record<string, unknown> })._embedded;
  const items = embeddedBlock?.items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is Resource => !!item && typeof item === 'object' && typeof (item as Resource).id === 'string');
}

function newestVersion(rows: Resource[]): Resource | undefined {
  const dated = rows.filter((row) => typeof row.createdAt === 'string' && row.createdAt);
  if (dated.length > 0) {
    return [...dated].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
  }
  return rows[0];
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
  if (collection.includes('authorizationAttributes') && constantNeedsUpdate(current, intended)) {
    return writeAttribute(input, collection, headers, current, intended, false);
  }
  if (!collection.includes('authorizationAttributes') || (!resolversMissingValueType(current) && !processorMissingName(current))) return current;
  const version = typeof current.version === 'string' ? current.version : '';
  if (!version) throw new Error(`PingOne attribute ${String(current.name)} is missing a version, so it cannot be repaired.`);
  return writeAttribute(input, collection, headers, current, { ...intended, resolvers: intendedResolvers(intended, current) }, true);
}

async function writeAttribute(
  input: ProvisionInput,
  collection: string,
  headers: Record<string, string>,
  current: Resource,
  intended: Record<string, unknown>,
  repair: boolean,
): Promise<Resource> {
  const version = typeof current.version === 'string' ? current.version : '';
  if (!version) throw new Error(`PingOne attribute ${String(current.name)} is missing a version, so it cannot be repaired.`);
  const body: Record<string, unknown> = { ...intended, id: current.id, version };
  await sendJson(input, `${collection}/${current.id}`, 'PUT', headers, body);
  await input.client.paceAfterManagementPost();
  const read = await readResource(input, `${collection}/${current.id}`, headers);
  if (read.id !== current.id) throw new Error(`PingOne attribute ${String(current.name)} read-back id did not match the repair.`);
  if (repair && resolversMissingValueType(read)) throw new Error(`PingOne attribute ${String(current.name)} still has a resolver without valueType.`);
  if (repair && processorMissingName(read)) throw new Error(`PingOne attribute ${String(current.name)} processor.name is still missing.`);
  if (!repair && constantNeedsUpdate(read, intended)) throw new Error(`PingOne attribute ${String(current.name)} did not keep the configured value.`);
  return read;
}

async function alignService(
  input: ProvisionInput,
  collection: string,
  headers: Record<string, string>,
  current: Resource,
  intended: Record<string, unknown>,
): Promise<Resource> {
  const requestMismatch = serviceRequestMismatch(current, intended);
  if (!serviceMissingLimits(current) && !requestMismatch) return current;
  const version = typeof current.version === 'string' ? current.version : '';
  if (!version) throw new Error(`PingOne service ${String(current.name)} is missing a version, so it cannot be repaired.`);
  const body = { ...intended, id: current.id, version };
  await sendJson(input, `${collection}/${current.id}`, 'PUT', headers, body);
  await input.client.paceAfterManagementPost();
  const read = await readResource(input, `${collection}/${current.id}`, headers);
  if (read.id !== current.id) throw new Error(`PingOne service ${String(current.name)} read-back id did not match the repair.`);
  if (serviceMissingLimits(read)) throw new Error(`PingOne service ${String(current.name)} is still missing its rate limits.`);
  if (serviceRequestMismatch(read, intended)) throw new Error(`PingOne service ${String(current.name)} did not keep the introspection request.`);
  return read;
}

function serviceRequestMismatch(current: Resource, intended: Record<string, unknown>): boolean {
  const left = serviceRequest(current);
  const right = serviceRequest(intended);
  return left.type !== right.type || left.name !== right.name || left.password !== right.password || left.body !== right.body;
}

function serviceRequest(body: Record<string, unknown>): { type: string; name: string; password: string; body: string } {
  const settings = body.serviceSettings as {
    body?: unknown;
    authentication?: { type?: unknown; name?: { id?: unknown }; password?: { id?: unknown } };
  } | undefined;
  const name = settings?.authentication?.name?.id;
  const password = settings?.authentication?.password?.id;
  return {
    type: typeof settings?.authentication?.type === 'string' ? settings.authentication.type : '',
    name: typeof name === 'string' ? name : '',
    password: typeof password === 'string' ? password : '',
    body: typeof settings?.body === 'string' ? settings.body : '',
  };
}

function constantNeedsUpdate(current: Resource, intended: Record<string, unknown>): boolean {
  const next = constantValue(intended);
  if (!next) return false;
  return constantValue(current) !== next;
}

function constantValue(body: Record<string, unknown>): string {
  const resolvers = body.resolvers as { type?: string; value?: unknown }[] | undefined;
  const constant = resolvers?.find((resolver) => resolver.type === 'CONSTANT');
  return typeof constant?.value === 'string' ? constant.value : '';
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

interface ServiceSettings {
  authentication?: { type?: string; name?: { id?: string }; password?: { id?: string } };
  body?: string;
  timeoutMilliseconds?: number;
  maximumConcurrentRequests?: number;
  maximumRequestsPerSecond?: number;
  headers?: unknown;
  contentType?: string;
}

function assertUserService(resource: Resource, tokenAttributeId: string, clientIdAttributeId: string): void {
  const settings = assertServiceShape(resource);
  if (settings.authentication?.type !== 'NONE') throw new Error(`${String(resource.name)} is not unauthenticated.`);
  if (settings.authentication.name || settings.authentication.password) throw new Error(`${String(resource.name)} still has authentication credentials.`);
  const expected = `token={{${tokenAttributeId}}}&client_id={{${clientIdAttributeId}}}`;
  if (settings.body !== expected) throw new Error(`${String(resource.name)} body is not token and client_id.`);
}

function assertService(resource: Resource, tokenAttributeId: string, clientId: string, secretId: string): void {
  const settings = assertServiceShape(resource);
  if (settings.authentication?.type !== 'BASIC') throw new Error(`${String(resource.name)} is not BASIC auth.`);
  if (settings.authentication.name?.id !== clientId || settings.authentication.password?.id !== secretId) {
    throw new Error(`${String(resource.name)} Basic auth does not point at the Definitions.`);
  }
  if (settings.body !== `token={{${tokenAttributeId}}}`) throw new Error(`${String(resource.name)} body does not use the token attribute id.`);
}

function assertServiceShape(resource: Resource): ServiceSettings {
  if (resource.parent) throw new Error(`${String(resource.name)} is not a top-level service.`);
  const settings = resource.serviceSettings as ServiceSettings;
  if (settings?.timeoutMilliseconds !== 3000) throw new Error(`${String(resource.name)} timeout is not 3000ms.`);
  if (settings.maximumConcurrentRequests !== 20) throw new Error(`${String(resource.name)} maximumConcurrentRequests is not 20.`);
  if (settings.maximumRequestsPerSecond !== 10) throw new Error(`${String(resource.name)} maximumRequestsPerSecond is not 10.`);
  if (!Array.isArray(settings.headers)) throw new Error(`${String(resource.name)} headers were not saved.`);
  if (settings.contentType !== 'application/x-www-form-urlencoded') throw new Error(`${String(resource.name)} content type is wrong.`);
  if ((resource.valueType as { type?: string } | undefined)?.type !== 'JSON') throw new Error(`${String(resource.name)} is not JSON.`);
  return settings;
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
