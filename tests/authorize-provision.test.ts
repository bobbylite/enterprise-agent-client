import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AuthorizeClient } from '../src/shared/authorize/remote';
import {
  attributeWriteError,
  authorizeWriteError,
  decisionParameters,
  decisionTokensReady,
  delegationRulePlans,
  groupsComparisonUsesCollection,
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

function pingone() {
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
      if (id === 'ver-1' && method === 'GET') return json({ id: 'ver-1', tag: { updatedAt: '2026-01-01T00:00:00.000Z' } });
      if (!id) {
        if (method === 'GET') {
          const rows = [...resources.values()].filter((item) => item.kind === kind);
          return json({ _embedded: { [kind]: rows } });
        }
        const created = `id-${(seq += 1)}`;
        const saved = { ...(body ?? {}), id: created, version: 'v1', kind, children: body?.children ?? [] };
        resources.set(created, saved);
        return json(shown(saved), 201);
      }
      if (method === 'GET') {
        const saved = resources.get(id);
        return saved ? json(shown(saved)) : json({ message: 'missing' }, 404);
      }
      const saved: Record<string, unknown> = { ...(resources.get(id) ?? {}), ...(body ?? {}), id, version: 'v2', kind };
      if (kind === 'decisionEndpoints' && body && !Object.prototype.hasOwnProperty.call(body, 'authorizationVersion')) {
        delete saved.authorizationVersion;
      }
      resources.set(id, saved);
      return json(shown(saved));
    },
  });
  return { client, calls, resources };
}

/** PingOne reads a REQUEST or SERVICE resolver without valueType. The create body still has to send it. */
function shown(saved: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(saved.resolvers)) return saved;
  return {
    ...saved,
    resolvers: saved.resolvers.map((resolver) => {
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
    expect(byName.get('introspect-client-id')?.resolvers[0]).toMatchObject({ type: 'CONSTANT', valueType: { type: 'STRING' } });
    expect(byName.get('introspect-client-secret')?.resolvers[0]).toMatchObject({ type: 'CONSTANT', valueType: { type: 'STRING' } });
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
    expect(posts).toContain('authorizationAttributes:introspect-client-secret');
    expect(posts).toContain('authorizationServices:EnterpriseAgent User Introspection');
    expect(posts).toContain('authorizationServices:EnterpriseAgent Delegation Introspection');
    expect(posts).toContain('authorizationPolicies:Enterprise Agent');
    expect(posts).toContain('authorizationPolicies:Enterprise Agent User');
    expect(posts).toContain('authorizationPolicies:Enterprise Agent Delegation');
    expect(posts.indexOf('authorizationAttributes:EnterpriseAgent')).toBeLessThan(posts.indexOf('authorizationServices:EnterpriseAgent User Introspection'));
    expect(posts.indexOf('authorizationServices:EnterpriseAgent User Introspection')).toBeLessThan(posts.indexOf('authorizationPolicies:Enterprise Agent User'));

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
    expect(settings.authentication.name.id).toBe(store.get('attribute', 'introspect-client-id')?.remoteId);
    expect(settings.authentication.password.id).toBe(store.get('attribute', 'introspect-client-secret')?.remoteId);
    expect(settings.body).toBe(`token={{${store.get('attribute', 'access-token')?.remoteId}}}`);
    expect(settings.url).toBe('https://auth.pingone.com/env-1/as/introspect');
    expect(settings.timeoutMilliseconds).toBe(3000);
    expect(settings).toMatchObject({ maximumConcurrentRequests: 20, maximumRequestsPerSecond: 10, headers: [] });
    expect(service?.body).not.toHaveProperty('parent');
    expect(service?.body).not.toHaveProperty('channel');
    expect(JSON.stringify(service?.body)).not.toMatch(/client-secret|super-secret|password=/i);

    const userPut = fake.calls.filter((call) => call.method === 'PUT' && call.url.includes('/authorizationPolicies/')).find((call) => {
      const children = call.body?.children as { name?: string; type?: string }[] | undefined;
      return children?.some((child) => child.name === 'High risk or inactive token');
    });
    const rules = userPut?.body?.children as { type: string; effectSettings: { type: string }; statements: { attributes: unknown[]; payload: string }[]; id?: string }[];
    expect(rules[0]?.type).toBe('RULE');
    expect(rules[0]?.effectSettings.type).toBe('UNCONDITIONAL_DENY');
    expect(rules[0]?.statements[0]?.attributes).toEqual([]);
    expect(rules[0]?.statements[0]).toMatchObject({ services: [], appliesIf: 'PATH_MATCHES' });
    expect(rules.at(-1)?.effectSettings.type).toBe('UNCONDITIONAL_PERMIT');
    expect(rulesReferenceIsApproved(userPut?.body)).toBe(false);
    expect(userPut?.body).toMatchObject({ id: expect.any(String), version: expect.any(String) });

    const delegationPut = fake.calls.filter((call) => call.method === 'PUT' && call.url.includes('/authorizationPolicies/')).find((call) => {
      const children = call.body?.children as { name?: string }[] | undefined;
      return children?.some((child) => child.name === 'Mapped human and agent');
    });
    expect(JSON.stringify(delegationPut?.body)).toContain('NOT_EQUALS');
    expect(JSON.stringify(delegationPut?.body)).not.toContain('isApproved');
    expect(groupsComparisonUsesCollection()).toBe(true);

    const parentPut = [...fake.calls].reverse().find((call) => call.method === 'PUT' && call.body?.combiningAlgorithm && JSON.stringify(call.body.combiningAlgorithm).includes('DENY_OVERRIDES'));
    const childAlgorithms = (parentPut?.body?.children as { combiningAlgorithm?: { algorithm?: string } }[] | undefined)?.map((child) => child.combiningAlgorithm?.algorithm);
    expect(childAlgorithms).toEqual(['FIRST_APPLICABLE', 'FIRST_APPLICABLE']);

    const endpointPut = fake.calls.find((call) => call.method === 'PUT' && call.url.includes('/decisionEndpoints/'));
    expect(endpointPut?.body?.authorizationVersion).toEqual({ id: 'ver-1' });

    const writes = fake.calls.filter((call) => call.method === 'POST' || call.method === 'PUT').length;
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
