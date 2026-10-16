import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthorizeClient } from '../src/shared/authorize/remote';
import {
  attributeWriteError,
  authorizeWriteError,
  decisionParameters,
  decisionTokensReady,
  delegationRulePlans,
  groupsComparisonUsesCollection,
  applyPolicyWrite,
  introspectionNote,
  redactSecret,
  rulesReferenceIsApproved,
  scaffoldPlan,
  serviceWriteError,
  userRulePlans,
} from '../src/shared/authorize/framework';
import { provisionAuthorize, type TfStore } from '../src/shared/authorize/provision';
import { parseEnterpriseConfig } from '../src/shared/config';

function memoryStore(): TfStore & { rows: Map<string, { remoteId: string; contentHash: string }> } {
  const rows = new Map<string, { remoteId: string; contentHash: string }>();
  return {
    rows,
    get(kind, name) {
      return rows.get(`${kind}:${name}`) ?? null;
    },
    put(kind, name, remoteId, contentHash) {
      rows.set(`${kind}:${name}`, { remoteId, contentHash });
    },
  };
}

function pingone(options?: { hidePolicyChildren?: boolean }) {
  const resources = new Map<string, Record<string, unknown>>();
  const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  let seq = 0;
  const client = new AuthorizeClient({
    sleep: async () => undefined,
    fetchImpl: async (url, init) => {
      const target = String(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ method, url: target, body });
      const rejected = authorizeWriteError(target, method, body);
      if (rejected) return json({ code: 'INVALID_DATA', message: rejected }, 400);
      const marker = target.match(/\/(authorizationAttributes|authorizationServices|authorizationPolicies|authorizationVersions|decisionEndpoints)(?:\/([^/?]+))?(?:\/(tag))?$/);
      if (!marker) return json({ message: target }, 404);
      const kind = marker[1] ?? '';
      const id = marker[2];
      if (kind === 'authorizationVersions' && !id && method === 'GET') {
        return json({ _embedded: { authorizationVersions: [{ id: 'ver-1' }] } });
      }
      if (marker[3] === 'tag' && method === 'PUT') return json({ id: 'ver-1', tag: { updatedAt: '2026-01-01T00:00:00.000Z' } });
      if (id && method === 'DELETE') {
        resources.delete(id);
        return new Response(null, { status: 204 });
      }
      if (id === 'ver-1' && method === 'GET') return json({ id: 'ver-1', tag: { updatedAt: '2026-01-01T00:00:00.000Z' } });
      if (!id) {
        if (method === 'GET') {
          const rows = [...resources.values()].filter((item) => item.kind === kind);
          return json({ _embedded: { [kind]: rows } });
        }
        const created = `id-${(seq += 1)}`;
        const saved =
          kind === 'authorizationPolicies'
            ? {
                ...applyPolicyWrite('POST', undefined, body, created, new Set(resources.keys()), () => `id-${(seq += 1)}`, (childId, child) => {
                  resources.set(childId, { ...child, kind: 'authorizationPolicies' });
                }),
                kind,
              }
            : { ...(body ?? {}), id: created, version: 'v1', kind, children: body?.children ?? [] };
        resources.set(created, saved);
        return json(shown(saved), 201);
      }
      if (method === 'GET') {
        const saved = resources.get(id);
        return saved ? json(shown(saved, options?.hidePolicyChildren === true)) : json({ message: 'missing' }, 404);
      }
      const saved: Record<string, unknown> = { ...(resources.get(id) ?? {}), ...(body ?? {}), id, version: 'v2', kind };
      if (kind === 'decisionEndpoints' && body && !Object.prototype.hasOwnProperty.call(body, 'authorizationVersion')) {
        delete saved.authorizationVersion;
      }
      if (kind === 'authorizationPolicies') {
        const prior = resources.get(id);
        Object.assign(
          saved,
          applyPolicyWrite('PUT', prior, body, id, new Set(resources.keys()), () => `id-${(seq += 1)}`, (childId, child) => {
            resources.set(childId, { ...child, kind: 'authorizationPolicies' });
          }),
          { kind },
        );
      }
      resources.set(id, saved);
      return json(shown(saved));
    },
  });
  return { client, calls, resources };
}

/** PingOne reads a REQUEST or SERVICE resolver without valueType. The create body still has to send it. */
function shown(saved: Record<string, unknown>, hidePolicyChildren = false): Record<string, unknown> {
  const visible = hidePolicyChildren && saved.kind === 'authorizationPolicies' ? { ...saved, children: [] } : saved;
  if (!Array.isArray(visible.resolvers)) return visible;
  return {
    ...visible,
    resolvers: visible.resolvers.map((resolver) => {
      if (!resolver || typeof resolver !== 'object') return resolver;
      const record = { ...(resolver as { type?: string; valueType?: unknown }) };
      if (record.type === 'CONSTANT') return resolver;
      delete record.valueType;
      return record;
    }),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function config() {
  const parsed = parseEnterpriseConfig(JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')));
  parsed.tenant.mode = 'pingone';
  parsed.tenant.apiHost = 'https://api.pingone.com';
  parsed.tenant.authHost = 'https://auth.pingone.com';
  parsed.tenant.environmentId = 'env-1';
  parsed.authorize.delegations = [{ humanSub: 'human-1', agentSub: 'agent-1', audience: 'api://agent', scope: 'mcp' }];
  return parsed;
}

describe('real Authorize scaffold', () => {
  it('plans a concrete valueType for every attribute and resolver from the default config', () => {
    const enterprise = parseEnterpriseConfig(JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')));
    const plan = scaffoldPlan(enterprise);
    expect(plan.attributes.length).toBeGreaterThan(0);
    for (const attribute of plan.attributes) {
      expect(attribute.valueType.type).toMatch(/^(STRING|NUMBER|JSON|BOOLEAN)$/);
      expect(attribute.resolvers.length).toBeGreaterThan(0);
      for (const resolver of attribute.resolvers) {
        expect(resolver.valueType).toEqual({ type: attribute.valueType.type });
      }
      if (attribute.processor) {
        expect(attribute.processor.name.startsWith('Extract ')).toBe(true);
        expect(attribute.processor.valueType).toEqual({ type: attribute.valueType.type });
        for (const resolver of attribute.resolvers) expect(resolver).not.toHaveProperty('processor');
      }
    }
    const byName = new Map(plan.attributes.map((attribute) => [attribute.name, attribute]));
    expect(byName.get('access-token')).toMatchObject({
      valueType: { type: 'STRING' },
      resolvers: [{ type: 'REQUEST', valueType: { type: 'STRING' } }],
    });
    expect(byName.get('tx-token')?.resolvers[0]?.valueType).toEqual({ type: 'STRING' });
    expect(byName.get('introspect-client-id')?.resolvers[0]).toMatchObject({ type: 'CONSTANT', value: '', valueType: { type: 'STRING' } });
    expect(byName.get('introspect-client-secret')?.resolvers[0]).toMatchObject({ type: 'CONSTANT', value: '', valueType: { type: 'STRING' } });
    expect(byName.get('user-introspect-client-id')?.resolvers[0]).toMatchObject({ type: 'CONSTANT', value: '', valueType: { type: 'STRING' } });
    expect(byName.get('user-introspect-client-secret')?.resolvers[0]).toMatchObject({ type: 'CONSTANT', value: '', valueType: { type: 'STRING' } });
    expect(byName.get('risk-score')?.valueType).toEqual({ type: 'NUMBER' });
    expect(byName.get('risk-score')?.resolvers[0]?.valueType).toEqual({ type: 'NUMBER' });
    expect(plan.services.map((service) => service.valueType)).toEqual([{ type: 'JSON' }, { type: 'JSON' }]);
  });

  it('builds attributes, services, and both policies, then does not write them again', async () => {
    const store = memoryStore();
    const fake = pingone();
    const enterprise = config();
    const first = await provisionAuthorize({
      config: enterprise,
      accessToken: 'worker-token',
      client: fake.client,
      store,
      adminGroup: 'Administrator',
      delegations: enterprise.authorize.delegations,
      alwaysCurrent: false,
    });
    expect(first.decisionEndpointId).toBeTruthy();
    const posts = fake.calls.filter((call) => call.method === 'POST').map((call) => `${call.url.split('/').pop()}:${String(call.body?.name ?? '')}`);
    expect(posts[0]).toBe('authorizationAttributes:EnterpriseAgent');
    expect(posts).toContain('authorizationAttributes:access-token');
    expect(posts).toContain('authorizationAttributes:tx-token');
    expect(posts).toContain('authorizationAttributes:risk-score');
    expect(posts).toContain('authorizationAttributes:user-introspect-client-id');
    expect(posts).toContain('authorizationAttributes:user-introspect-client-secret');
    expect(posts).toContain('authorizationAttributes:introspect-client-secret');
    expect(posts).toContain('authorizationServices:EnterpriseAgent User Introspection');
    expect(posts).toContain('authorizationServices:EnterpriseAgent Delegation Introspection');
    expect(posts).toContain('authorizationPolicies:Enterprise Agent Features');
    expect(posts).not.toContain('authorizationPolicies:Enterprise Agent User');
    expect(posts).not.toContain('authorizationPolicies:Enterprise Agent Delegation');
    expect(posts.indexOf('authorizationAttributes:EnterpriseAgent')).toBeLessThan(posts.indexOf('authorizationServices:EnterpriseAgent User Introspection'));
    expect(posts.indexOf('authorizationServices:EnterpriseAgent User Introspection')).toBeLessThan(posts.indexOf('authorizationPolicies:Enterprise Agent Features'));

    const attributePosts = fake.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/authorizationAttributes'));
    for (const call of attributePosts) {
      const resolvers = call.body?.resolvers as { valueType?: { type?: string } }[] | undefined;
      const attributeType = (call.body?.valueType as { type?: string } | undefined)?.type;
      expect(resolvers?.length).toBeGreaterThan(0);
      for (const resolver of resolvers ?? []) expect(resolver.valueType).toEqual({ type: attributeType });
    }
    const request = fake.calls.find((call) => call.method === 'POST' && call.body?.name === 'access-token');
    expect(request?.body?.resolvers).toEqual([{ type: 'REQUEST', valueType: { type: 'STRING' } }]);
    expect(request?.body).not.toHaveProperty('processor');
    expect(request?.body?.parent).toEqual({ id: store.get('attribute', 'EnterpriseAgent')?.remoteId });
    const score = fake.calls.find((call) => call.method === 'POST' && call.body?.name === 'risk-score');
    expect(score?.body?.valueType).toEqual({ type: 'NUMBER' });
    expect(score?.body?.resolvers).toEqual([{ type: 'REQUEST', valueType: { type: 'NUMBER' } }]);
    const claim = fake.calls.find((call) => call.method === 'POST' && call.body?.name === 'tx-act-sub');
    expect(claim?.body?.resolvers).toEqual([
      { type: 'SERVICE', value: { id: store.get('service', 'EnterpriseAgent Delegation Introspection')?.remoteId }, valueType: { type: 'STRING' } },
    ]);
    expect(claim?.body?.processor).toEqual({
      type: 'JSON_PATH',
      name: 'Extract tx-act-sub',
      expression: '$.act.sub',
      valueType: { type: 'STRING' },
    });
    const claimResolver = (claim?.body?.resolvers as Record<string, unknown>[] | undefined)?.[0];
    expect(claimResolver).not.toHaveProperty('processor');

    const service = fake.calls.find((call) => call.method === 'POST' && call.body?.name === 'EnterpriseAgent User Introspection');
    expect(service?.body).not.toHaveProperty('parent');
    const settings = service?.body?.serviceSettings as {
      authentication: { type: string; name: { id: string }; password: { id: string } };
      body: string;
      url: string;
      timeoutMilliseconds: number;
    };
    expect(settings.authentication.type).toBe('BASIC');
    expect(settings.authentication.name.id).toBe(store.get('attribute', 'user-introspect-client-id')?.remoteId);
    expect(settings.authentication.password.id).toBe(store.get('attribute', 'user-introspect-client-secret')?.remoteId);
    expect(settings.authentication.name.id).not.toBe(store.get('attribute', 'introspect-client-id')?.remoteId);
    const delegation = fake.calls.find((call) => call.method === 'POST' && call.body?.name === 'EnterpriseAgent Delegation Introspection');
    const delegationAuth = (delegation?.body?.serviceSettings as { authentication: { name: { id: string }; password: { id: string } } }).authentication;
    expect(delegationAuth.name.id).toBe(store.get('attribute', 'introspect-client-id')?.remoteId);
    expect(delegationAuth.password.id).toBe(store.get('attribute', 'introspect-client-secret')?.remoteId);
    expect(settings.body).toBe(`token={{${store.get('attribute', 'access-token')?.remoteId}}}`);
    expect(settings.url).toBe('https://auth.pingone.com/env-1/as/introspect');
    expect(settings.timeoutMilliseconds).toBe(3000);
    expect(settings).toMatchObject({ maximumConcurrentRequests: 20, maximumRequestsPerSecond: 10, headers: [] });
    expect(service?.body).not.toHaveProperty('parent');
    expect(service?.body).not.toHaveProperty('channel');
    expect(JSON.stringify(service?.body)).not.toMatch(/client-secret|super-secret|password=/i);

    const treePosts = fake.calls.filter((call) => call.method === 'POST' && call.body?.name === 'Enterprise Agent Features');
    expect(treePosts).toHaveLength(1);
    expect(fake.calls.filter((call) => call.method === 'PUT' && String(call.url).includes('/authorizationPolicies/'))).toHaveLength(0);
    const tree = treePosts[0]?.body;
    expect(tree).toMatchObject({ type: 'POLICY' });
    expect(tree).not.toHaveProperty('id');
    expect(tree).not.toHaveProperty('version');
    const inlineChildren = tree?.children as {
      id?: string;
      type?: string;
      name?: string;
      combiningAlgorithm?: { algorithm?: string };
      children?: { type: string; name?: string; effectSettings: { type: string }; statements: { attributes: unknown[]; payload: string }[] }[];
    }[];
    expect(inlineChildren.map((child) => child.name)).toEqual(['Enterprise Agent User', 'Enterprise Agent Delegation']);
    expect(inlineChildren.every((child) => child.type === 'POLICY' && !child.id)).toBe(true);
    expect(inlineChildren.map((child) => child.combiningAlgorithm?.algorithm)).toEqual(['FIRST_APPLICABLE', 'FIRST_APPLICABLE']);
    const rules = inlineChildren[0]?.children ?? [];
    expect(rules[0]?.type).toBe('RULE');
    expect(rules[0]?.name).toBe('High risk or inactive token');
    expect(rules[0]?.effectSettings.type).toBe('UNCONDITIONAL_DENY');
    expect(rules[0]?.statements[0]?.attributes).toEqual([]);
    expect(rules[0]?.statements[0]).toMatchObject({ services: [], appliesIf: 'PATH_MATCHES', type: 'EMBEDDED_STATEMENT' });
    expect(rules.every((rule) => !('id' in rule) && !('version' in rule))).toBe(true);
    expect(rules.at(-1)?.effectSettings.type).toBe('UNCONDITIONAL_PERMIT');
    expect(rulesReferenceIsApproved(tree)).toBe(false);
    expect(JSON.stringify(inlineChildren[1])).toContain('NOT_EQUALS');
    expect(JSON.stringify(inlineChildren[1])).toContain('Mapped human and agent');
    expect(JSON.stringify(tree)).not.toContain('isApproved');
    expect(groupsComparisonUsesCollection()).toBe(true);

    const endpointPut = fake.calls.find((call) => call.method === 'PUT' && call.url.includes('/decisionEndpoints/'));
    expect(endpointPut?.body?.authorizationVersion).toEqual({ id: 'ver-1' });

    const writes = fake.calls.filter((call) => call.method === 'POST' || call.method === 'PUT').length;
    fake.resources.set('later-orphan', {
      id: 'later-orphan',
      name: 'Enterprise Agent User',
      kind: 'authorizationPolicies',
      version: 'v1',
      type: 'POLICY',
      enabled: true,
      children: [],
    });
    await provisionAuthorize({
      config: enterprise,
      accessToken: 'worker-token',
      client: fake.client,
      store,
      adminGroup: 'Administrator',
      delegations: enterprise.authorize.delegations,
      alwaysCurrent: false,
    });
    expect(fake.calls.filter((call) => call.method === 'POST' || call.method === 'PUT')).toHaveLength(writes);
    expect(fake.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    expect(fake.resources.has('later-orphan')).toBe(true);
  });

  it('points an existing user service at the SSO client and leaves the policy tree alone', async () => {
    const store = memoryStore();
    const fake = pingone();
    const enterprise = config();
    enterprise.authorize.userIntrospection.clientId = 'sso-resource-client';
    const secret = 'sso-resource-secret-value';
    const logs: string[] = [];
    await provisionAuthorize({
      config: enterprise,
      accessToken: 'worker-token',
      client: fake.client,
      store,
      adminGroup: 'Administrator',
      delegations: enterprise.authorize.delegations,
      alwaysCurrent: false,
      userIntrospection: { clientId: 'sso-resource-client', clientSecret: secret },
      log: (_level, message) => logs.push(message),
    });
    const userServiceId = store.get('service', 'EnterpriseAgent User Introspection')?.remoteId ?? '';
    const delegationServiceId = store.get('service', 'EnterpriseAgent Delegation Introspection')?.remoteId ?? '';
    const agentClientId = store.get('attribute', 'introspect-client-id')?.remoteId ?? '';
    const agentSecretId = store.get('attribute', 'introspect-client-secret')?.remoteId ?? '';
    const userClientAttribute = store.get('attribute', 'user-introspect-client-id')?.remoteId ?? '';
    const userSecretAttribute = store.get('attribute', 'user-introspect-client-secret')?.remoteId ?? '';
    const userService = fake.resources.get(userServiceId);
    const settings = userService?.serviceSettings as { authentication: { name: { id: string }; password: { id: string } } };
    settings.authentication.name.id = agentClientId;
    settings.authentication.password.id = agentSecretId;
    fake.resources.delete(userClientAttribute);
    fake.resources.delete(userSecretAttribute);
    store.rows.delete('attribute:user-introspect-client-id');
    store.rows.delete('attribute:user-introspect-client-secret');
    const mark = fake.calls.length;
    const deletes = fake.calls.filter((call) => call.method === 'DELETE').length;
    await provisionAuthorize({
      config: enterprise,
      accessToken: 'worker-token',
      client: fake.client,
      store,
      adminGroup: 'Administrator',
      delegations: enterprise.authorize.delegations,
      alwaysCurrent: false,
      userIntrospection: { clientId: 'sso-resource-client', clientSecret: secret },
      log: (_level, message) => logs.push(message),
    });
    const added = fake.calls.slice(mark);
    const posts = added.filter((call) => call.method === 'POST').map((call) => String(call.body?.name));
    expect(posts).toContain('user-introspect-client-id');
    expect(posts).toContain('user-introspect-client-secret');
    expect(posts).not.toContain('Enterprise Agent Features');
    const servicePut = added.find((call) => call.method === 'PUT' && call.url.includes(`/authorizationServices/${userServiceId}`));
    const auth = (servicePut?.body?.serviceSettings as { authentication: { name: { id: string }; password: { id: string } } }).authentication;
    expect(auth.name.id).toBe(store.get('attribute', 'user-introspect-client-id')?.remoteId);
    expect(auth.password.id).toBe(store.get('attribute', 'user-introspect-client-secret')?.remoteId);
    expect(auth.name.id).not.toBe(agentClientId);
    expect(added.filter((call) => call.method === 'PUT' && call.url.includes(`/authorizationServices/${delegationServiceId}`))).toHaveLength(0);
    expect(added.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    expect(fake.calls.filter((call) => call.method === 'DELETE')).toHaveLength(deletes);
    const secretPost = added.find((call) => call.method === 'POST' && call.body?.name === 'user-introspect-client-secret');
    expect(JSON.stringify(secretPost?.body)).toContain(secret);
    expect(logs.join('\n')).not.toContain(secret);
    expect(redactSecret(`secret ${secret}`, secret)).toBe('secret [redacted]');
    const note = introspectionNote('sso-resource-client', true);
    expect(note).toContain('sso-resource-client');
    expect(note).toContain('user-introspect-client-id');
    expect(note).toContain('introspect-client-id');
    expect(note).not.toContain(secret);
    const directory = mkdtempSync(join(tmpdir(), 'authorize-dry-'));
    const path = join(directory, 'authorize-policy-tree.json');
    await provisionAuthorize({
      config: enterprise,
      accessToken: 'worker-token',
      client: fake.client,
      store,
      adminGroup: 'Administrator',
      delegations: enterprise.authorize.delegations,
      alwaysCurrent: false,
      userIntrospection: { clientId: 'sso-resource-client', clientSecret: secret },
      dryRun: true,
      dryRunPath: path,
      log: (_level, message) => logs.push(message),
    });
    const dryRun = readFileSync(path, 'utf8');
    expect(dryRun).not.toContain(secret);
    expect(dryRun).toContain('Enterprise Agent Features');
    expect(logs.join('\n')).not.toContain(secret);
  });

  it('rejects an introspection secret stored in enterprise.json', () => {
    const raw = JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')) as {
      authorize: { userIntrospection: { clientId: string; clientSecret?: string } };
    };
    raw.authorize.userIntrospection.clientSecret = 'do-not-commit';
    expect(() => parseEnterpriseConfig(raw)).toThrow(/clientSecret/);
  });

  it('creates the child policies inline and deletes only the exact-name orphans', async () => {
    const store = memoryStore();
    const fake = pingone();
    fake.resources.set('root-existing', {
      id: 'root-existing',
      name: 'Enterprise Agent',
      kind: 'authorizationPolicies',
      version: 'v1',
      type: 'POLICY',
      enabled: true,
      description: 'parent',
      combiningAlgorithm: { algorithm: 'FIRST_APPLICABLE' },
      children: [],
    });
    fake.resources.set('features-empty', {
      id: 'features-empty',
      name: 'Enterprise Agent Features',
      kind: 'authorizationPolicies',
      version: '7f917502',
      type: 'POLICY',
      enabled: true,
      combiningAlgorithm: { algorithm: 'DENY_OVERRIDES' },
      children: [],
    });
    for (const [id, name] of [
      ['user-orphan', 'Enterprise Agent User'],
      ['delegation-orphan', 'Enterprise Agent Delegation'],
    ] as const) {
      fake.resources.set(id, {
        id,
        name,
        kind: 'authorizationPolicies',
        version: 'v1',
        type: 'POLICY',
        enabled: true,
        combiningAlgorithm: { algorithm: 'FIRST_APPLICABLE' },
        children: [],
      });
    }
    fake.resources.set('keep-me', {
      id: 'keep-me',
      name: 'Keep Me',
      kind: 'authorizationPolicies',
      version: 'v1',
      type: 'POLICY',
      enabled: true,
      children: [],
    });
    const enterprise = config();
    const result = await provisionAuthorize({
      config: enterprise,
      accessToken: 'worker-token',
      client: fake.client,
      store,
      adminGroup: 'Administrator',
      delegations: enterprise.authorize.delegations,
      alwaysCurrent: false,
    });
    expect(result.policies.map((policy) => policy.remoteId)).not.toContain('user-orphan');
    expect(fake.resources.has('user-orphan')).toBe(false);
    expect(fake.resources.has('delegation-orphan')).toBe(false);
    expect(fake.resources.has('keep-me')).toBe(true);
    const deleted = fake.calls.filter((call) => call.method === 'DELETE').map((call) => call.url);
    expect(deleted).toEqual(expect.arrayContaining([expect.stringContaining('/user-orphan'), expect.stringContaining('/delegation-orphan')]));
    expect(deleted.some((url) => url.includes('keep-me') || url.includes('root-existing'))).toBe(false);
    const postIndex = fake.calls.findIndex((call) => call.method === 'POST' && call.body?.name === 'Enterprise Agent Features');
    const shellDelete = fake.calls.findIndex((call) => call.method === 'DELETE' && call.url.includes('/features-empty'));
    const orphanDelete = fake.calls.findIndex((call) => call.method === 'DELETE' && call.url.includes('/user-orphan'));
    expect(postIndex).toBeGreaterThan(-1);
    expect(shellDelete).toBeGreaterThan(-1);
    expect(shellDelete).toBeLessThan(postIndex);
    expect(orphanDelete).toBeGreaterThan(postIndex);
    expect(fake.resources.has('features-empty')).toBe(false);
    expect(fake.calls.some((call) => call.method === 'PUT' && call.url.includes('/root-existing'))).toBe(false);
    expect(fake.resources.get('root-existing')?.children).toEqual([]);
    const parent = [...fake.resources.values()].find((item) => item.name === 'Enterprise Agent Features');
    const refs = parent?.children as { type?: string; name?: string; value?: { id?: string } }[];
    expect(refs?.map((child) => child.type)).toEqual(['POLICY', 'POLICY']);
    expect(refs?.every((child) => !child.name && child.value?.id && child.value.id !== 'user-orphan' && child.value.id !== 'delegation-orphan')).toBe(true);
    expect(refs?.map((child) => fake.resources.get(child.value?.id ?? '')?.name)).toEqual(['Enterprise Agent User', 'Enterprise Agent Delegation']);
  });

  it('does not delete anything when the read-back is missing the child policies', async () => {
    const store = memoryStore();
    const fake = pingone({ hidePolicyChildren: true });
    const logs: { level: string; message: string }[] = [];
    fake.resources.set('user-orphan', {
      id: 'user-orphan',
      name: 'Enterprise Agent User',
      kind: 'authorizationPolicies',
      version: 'v1',
      type: 'POLICY',
      enabled: true,
      children: [{ type: 'RULE', name: 'High risk or inactive token' }],
    });
    const enterprise = config();
    await expect(
      provisionAuthorize({
        config: enterprise,
        accessToken: 'worker-token',
        client: fake.client,
        store,
        adminGroup: 'Administrator',
        delegations: enterprise.authorize.delegations,
        alwaysCurrent: false,
        log: (level, message) => logs.push({ level, message }),
        logPath: '/tmp/enterprise-agent-client/main.log',
      }),
    ).rejects.toThrow(/Missing policy Enterprise Agent User/);
    expect(fake.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    expect(fake.resources.has('user-orphan')).toBe(true);
    const failure = logs.find((entry) => entry.level === 'error');
    expect(failure?.message).toContain('Enterprise Agent Features');
    expect(failure?.message).toContain('POST children');
    expect(failure?.message).toContain('GET children');
    expect(failure?.message).toContain('"valueId"');
  });

  it('writes the planned tree and does not create, update, or delete PingOne objects', async () => {
    const store = memoryStore();
    const fake = pingone();
    fake.resources.set('old-parent', {
      id: 'old-parent',
      name: 'Enterprise Agent',
      kind: 'authorizationPolicies',
      version: 'v3',
      type: 'POLICY',
      enabled: true,
      children: [],
    });
    fake.resources.set('features', {
      id: 'features',
      name: 'Enterprise Agent Features',
      kind: 'authorizationPolicies',
      version: 'v4',
      type: 'POLICY',
      enabled: true,
      combiningAlgorithm: { algorithm: 'DENY_OVERRIDES' },
      children: [],
    });
    const directory = mkdtempSync(join(tmpdir(), 'authorize-tree-'));
    const path = join(directory, 'authorize-policy-tree.json');
    const enterprise = config();
    const result = await provisionAuthorize({
      config: enterprise,
      accessToken: 'worker-token',
      client: fake.client,
      store,
      adminGroup: 'Administrator',
      delegations: enterprise.authorize.delegations,
      alwaysCurrent: false,
      dryRun: true,
      dryRunPath: path,
    });
    expect(result.dryRunPath).toBe(path);
    expect(result.policies).toEqual([]);
    expect(fake.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(fake.resources.has('old-parent')).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf8')) as {
      id?: string;
      version?: string;
      name?: string;
      children?: { type?: string; id?: string; name?: string; children?: { type?: string; id?: string; name?: string }[] }[];
    };
    expect(written).toMatchObject({ name: 'Enterprise Agent Features', type: 'POLICY' });
    expect(written.id).toBeUndefined();
    expect(written.version).toBeUndefined();
    expect(written.children?.map((child) => child.name)).toEqual(['Enterprise Agent User', 'Enterprise Agent Delegation']);
    expect(written.children?.every((child) => child.type === 'POLICY' && !child.id)).toBe(true);
    const rules = written.children?.[0]?.children ?? [];
    expect(rules[0]?.name).toBe('High risk or inactive token');
    expect(rules.every((rule) => rule.type === 'RULE' && !rule.id)).toBe(true);
    expect(JSON.stringify(written)).toContain('{{risk-level}}');
    expect(JSON.stringify(written)).not.toContain('isApproved');
    expect(fake.resources.get('features')?.version).toBe('v4');
    expect(fake.resources.get('features')?.children).toEqual([]);
  });

  it('ignores children on a policy PUT and keeps the same version', async () => {
    const fake = pingone();
    fake.resources.set('policy-1', {
      id: 'policy-1',
      name: 'Enterprise Agent Features',
      kind: 'authorizationPolicies',
      version: '7f917502',
      type: 'POLICY',
      enabled: true,
      combiningAlgorithm: { algorithm: 'DENY_OVERRIDES' },
      children: [],
    });
    const response = await fake.client.request('https://api.pingone.com/v1/environments/env-1/authorizationPolicies/policy-1', {
      method: 'PUT',
      body: JSON.stringify({
        type: 'POLICY',
        id: 'policy-1',
        version: '7f917502',
        name: 'Enterprise Agent Features',
        enabled: true,
        combiningAlgorithm: { algorithm: 'DENY_OVERRIDES' },
        children: [
          {
            type: 'POLICY',
            name: 'Enterprise Agent User',
            description: 'inline',
            enabled: true,
            combiningAlgorithm: { algorithm: 'FIRST_APPLICABLE' },
            children: [],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const read = await fake.client.request('https://api.pingone.com/v1/environments/env-1/authorizationPolicies/policy-1');
    const body = (await read.json()) as { children?: unknown[]; version?: string };
    expect(body.children).toEqual([]);
    expect(body.version).toBe('7f917502');
  });

  it('reuses a half-created parent by name and does not replace a console secret', async () => {
    const store = memoryStore();
    const fake = pingone();
    fake.resources.set('parent-existing', {
      id: 'parent-existing',
      name: 'EnterpriseAgent',
      type: 'ATTRIBUTE',
      kind: 'authorizationAttributes',
      version: 'v1',
      valueType: { type: 'JSON' },
      resolvers: [{ type: 'CONSTANT', value: '{}' }],
    });
    fake.resources.set('secret-existing', {
      id: 'secret-existing',
      name: 'introspect-client-secret',
      type: 'ATTRIBUTE',
      kind: 'authorizationAttributes',
      version: 'v1',
      parent: { id: 'parent-existing' },
      valueType: { type: 'STRING' },
      resolvers: [{ type: 'CONSTANT', value: 'pasted-secret', valueType: { type: 'STRING' } }],
    });
    const enterprise = config();
    const result = await provisionAuthorize({
      config: enterprise,
      accessToken: 'worker-token',
      client: fake.client,
      store,
      adminGroup: 'Administrator',
      delegations: enterprise.authorize.delegations,
      alwaysCurrent: false,
    });
    expect(result.decisionEndpointId).toBeTruthy();
    expect(fake.calls.filter((call) => call.method === 'POST' && call.body?.name === 'EnterpriseAgent')).toHaveLength(0);
    expect(fake.calls.filter((call) => call.method === 'POST' && call.body?.name === 'introspect-client-secret')).toHaveLength(0);
    const repair = fake.calls.find((call) => call.method === 'PUT' && call.url.endsWith('/authorizationAttributes/parent-existing'));
    expect(repair?.body?.resolvers).toEqual([{ type: 'CONSTANT', value: '{}', valueType: { type: 'JSON' } }]);
    expect(repair?.body).toMatchObject({ id: 'parent-existing', version: 'v1' });
    expect(fake.calls.filter((call) => call.url.includes('/authorizationAttributes/secret-existing') && call.method === 'PUT')).toHaveLength(0);
    expect(fake.resources.get('secret-existing')?.resolvers).toEqual([{ type: 'CONSTANT', value: 'pasted-secret', valueType: { type: 'STRING' } }]);
    expect(store.get('attribute', 'EnterpriseAgent')?.remoteId).toBe('parent-existing');
    expect(store.get('attribute', 'introspect-client-secret')?.remoteId).toBe('secret-existing');
  });

  it('rejects a service without rate limits and reuses attributes from an earlier attempt', async () => {
    const almost = {
      type: 'SERVICE',
      serviceType: 'HTTP',
      valueType: { type: 'JSON' },
      serviceSettings: {
        type: 'HTTP',
        url: 'https://auth.example/env-1/as/introspect',
        verb: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        body: 'token={{token-id}}',
        headers: [],
        maximumRequestsPerSecond: 10,
        timeoutMilliseconds: 3000,
        authentication: { type: 'BASIC', name: { id: 'client' }, password: { id: 'secret' } },
        tlsSettings: { tlsValidationType: 'DEFAULT' },
      },
    };
    expect(attributeWriteError({
      name: 'introspection-groups',
      type: 'ATTRIBUTE',
      valueType: { type: 'STRING' },
      resolvers: [{ type: 'SERVICE', value: { id: 'svc' }, valueType: { type: 'STRING' } }],
      processor: { type: 'JSON_PATH', expression: '$.groups', valueType: { type: 'STRING' } },
    })).toMatch(/processor\.name/);
    expect(serviceWriteError(almost)).toMatch(/maximumConcurrentRequests/);
    expect(serviceWriteError({ ...almost, serviceSettings: { ...almost.serviceSettings, maximumConcurrentRequests: 0 } })).toMatch(/OUT_OF_RANGE/);
    const store = memoryStore();
    const fake = pingone();
    const rejected = await fake.client.request('https://api.pingone.com/v1/environments/env-1/authorizationServices', {
      method: 'POST',
      body: JSON.stringify({ name: 'incomplete', ...almost, serviceSettings: { ...almost.serviceSettings, maximumConcurrentRequests: 0 } }),
    });
    expect(rejected.status).toBe(400);
    const parentId = 'parent-existing';
    fake.resources.set(parentId, {
      id: parentId,
      name: 'EnterpriseAgent',
      kind: 'authorizationAttributes',
      version: 'v1',
      type: 'ATTRIBUTE',
      valueType: { type: 'JSON' },
      resolvers: [{ type: 'CONSTANT', value: '{}', valueType: { type: 'JSON' } }],
    });
    for (const name of ['access-token', 'tx-token', 'risk-level', 'risk-score', 'risk-action', 'admin-group', 'introspect-client-id', 'introspect-client-secret']) {
      const definition = name.startsWith('introspect-');
      fake.resources.set(`attr-${name}`, {
        id: `attr-${name}`,
        name,
        kind: 'authorizationAttributes',
        version: 'v1',
        type: 'ATTRIBUTE',
        parent: { id: parentId },
        valueType: { type: name === 'risk-score' ? 'NUMBER' : 'STRING' },
        resolvers: definition
          ? [{ type: 'CONSTANT', value: name.endsWith('secret') ? 'pasted-secret' : '', valueType: { type: 'STRING' } }]
          : [{ type: 'REQUEST' }],
      });
    }
    const enterprise = config();
    const result = await provisionAuthorize({
      config: enterprise,
      accessToken: 'worker-token',
      client: fake.client,
      store,
      adminGroup: 'Administrator',
      delegations: enterprise.authorize.delegations,
      alwaysCurrent: false,
    });
    expect(result.decisionEndpointId).toBeTruthy();
    const kept = new Set(['EnterpriseAgent', 'access-token', 'tx-token', 'risk-level', 'risk-score', 'risk-action', 'admin-group', 'introspect-client-id', 'introspect-client-secret']);
    expect(fake.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/authorizationAttributes') && kept.has(String(call.body?.name)))).toEqual([]);
    const service = fake.calls.find((call) => call.method === 'POST' && call.body?.name === 'EnterpriseAgent User Introspection');
    expect(service?.body?.serviceSettings).toMatchObject({ maximumConcurrentRequests: 20, maximumRequestsPerSecond: 10, timeoutMilliseconds: 3000, headers: [] });
    expect(fake.resources.get('attr-introspect-client-secret')?.resolvers).toEqual([{ type: 'CONSTANT', value: 'pasted-secret', valueType: { type: 'STRING' } }]);
  });

  it('sends full attribute names, a numeric score, and placeholders', () => {
    expect(decisionTokensReady('', 'tx')).toBe(false);
    expect(decisionTokensReady('access', '   ')).toBe(false);
    const body = decisionParameters({
      userId: 'user-1',
      username: 'ada',
      groups: ['Administrator'],
      riskLevel: 'LOW',
      riskAction: 'allow',
      accessToken: 'access-token',
      txToken: 'tx-token',
      adminGroup: 'Administrator',
    });
    expect(body.parameters).toEqual({
      'EnterpriseAgent.access-token': 'access-token',
      'EnterpriseAgent.tx-token': 'tx-token',
      'EnterpriseAgent.risk-level': 'LOW',
      'EnterpriseAgent.risk-score': 10,
      'EnterpriseAgent.risk-action': 'allow',
      'EnterpriseAgent.admin-group': 'Administrator',
    });
    const unknown = decisionParameters({
      ...body,
      userId: 'user-1',
      username: 'ada',
      groups: [],
      riskLevel: 'UNKNOWN',
      riskAction: 'allow',
      accessToken: 'access-token',
      txToken: 'tx-token',
      adminGroup: 'Administrator',
    });
    expect(unknown.parameters['EnterpriseAgent.risk-level']).toBe('UNKNOWN');
    expect(unknown.parameters['EnterpriseAgent.risk-score']).toBe(0);
    expect(userRulePlans('Administrator').at(-1)?.effect).toBe('PERMIT');
    expect(delegationRulePlans([]).map((rule) => rule.name)).toEqual(['Active delegation']);
    expect(rulesReferenceIsApproved(delegationRulePlans([{ humanSub: 'h', agentSub: 'a', audience: '', scope: '' }]))).toBe(false);
  });
});
