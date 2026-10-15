import type { EnterpriseConfig } from '../config';
import { decisionParameters, type DecisionCall } from './framework';
import { FEATURE_STATEMENT, SCAFFOLD_MARKER, type AuthorizePolicy } from './policy';

const MAX_ATTEMPTS = 4;

/** Gap between management POSTs so a burst does not trip REQUEST_LIMITED. */
export const MANAGEMENT_POST_GAP_MS = 300;

export interface AuthorizeClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  maxAttempts?: number;
}

export class AuthorizeClient {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly maxAttempts: number;

  constructor(options: AuthorizeClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  }

  /** Runs Authorize work one call at a time. Nested work reuses the current turn. */
  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.depth > 0) return work();
    return this.enqueue(async () => {
      this.depth += 1;
      try {
        return await work();
      } finally {
        this.depth -= 1;
      }
    });
  }

  request(url: string, init: RequestInit = {}): Promise<Response> {
    const send = () => this.requestWithRetry(url, init);
    if (this.depth > 0) return send();
    return this.enqueue(async () => {
      this.depth += 1;
      try {
        return await send();
      } finally {
        this.depth -= 1;
      }
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async requestWithRetry(url: string, init: RequestInit): Promise<Response> {
    let retryAfter = 1;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const response = await this.fetchImpl(url, init);
      if (response.status !== 429) return response;
      const text = (await response.text()).trim();
      if (quotaExceeded(text)) {
        throw new Error(
          'PingOne Authorize quota is exceeded. Trial licenses cap policy resources and cannot raise the base rate.',
        );
      }
      retryAfter = retryAfterSeconds(response, this.now()) ?? retryAfter;
      if (attempt === this.maxAttempts - 1) {
        throw new Error(`PingOne is rate limiting, try again in ${Math.max(1, Math.ceil(retryAfter))}s`);
      }
      const backoffMs = Math.max(retryAfter, 0) * 1000 * 2 ** attempt;
      const jitterMs = backoffMs * 0.25 * this.random();
      await this.sleep(backoffMs + jitterMs);
    }
    throw new Error(`PingOne is rate limiting, try again in ${Math.max(1, Math.ceil(retryAfter))}s`);
  }

  /** Waits between successful management creates. Tests inject sleep so this stays instant. */
  paceAfterManagementPost(): Promise<void> {
    return this.sleep(MANAGEMENT_POST_GAP_MS);
  }
}

export function retryAfterSeconds(response: Response, now: number): number | null {
  const header = response.headers.get('retry-after')?.trim();
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, (date - now) / 1000);
  return null;
}

function quotaExceeded(body: string): boolean {
  return body.includes('QUOTA_EXCEEDED');
}

export function authorizationPoliciesUrl(config: EnterpriseConfig, id?: string): string {
  const base = `${trimSlash(config.tenant.apiHost)}/v1/environments/${config.tenant.environmentId}/authorizationPolicies`;
  return id ? `${base}/${id}` : base;
}

export function decisionUrl(config: EnterpriseConfig): string {
  return `${trimSlash(config.tenant.apiHost)}/v1/environments/${config.tenant.environmentId}/decisionEndpoints/${config.authorize.decisionEndpointId}`;
}

export function remotePolicyBody(policy: AuthorizePolicy): Record<string, unknown> {
  // Free-standing library policy. Omit parent: POST-with-parent can return 201 and still
  // place the policy under the shared Policies root instead of an AAM Custom node.
  return {
    type: 'POLICY',
    name: policy.name,
    description: `${policy.description}\n\n${SCAFFOLD_MARKER}\n${JSON.stringify({ id: policy.id, when: policy.when, effect: policy.effect })}`,
    enabled: policy.enabled,
    combiningAlgorithm: { algorithm: 'DENY_OVERRIDES' },
    statements: [
      {
        name: 'Enterprise agent features',
        description: 'Returned on PERMIT so the desktop client can turn UI features and tools on or off.',
        code: FEATURE_STATEMENT,
        appliesTo: 'PERMIT_OR_DENY',
        appliesIf: 'FINAL_DECISION_MATCHES',
        payload: JSON.stringify({
          policyTab: false,
          pingoneTools: false,
          mcpWrites: false,
          chat: 'read_only',
          note: 'Replace this payload with the decision for the current request attributes.',
        }),
        obligatory: false,
        attributes: [],
        services: [],
      },
    ],
  };
}

export interface RemotePolicy {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  updatedAt: number | null;
}

export async function listRemotePolicies(
  config: EnterpriseConfig,
  accessToken: string,
  client: AuthorizeClient,
): Promise<RemotePolicy[]> {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  const rows: RemotePolicy[] = [];
  const seen = new Set<string>();
  let url: string | null = authorizationPoliciesUrl(config);
  while (url && !seen.has(url) && seen.size < 20) {
    seen.add(url);
    const response = await client.request(url, { headers });
    if (!response.ok) throw new Error(await errorText(response, 'PingOne did not list authorization policies'));
    const body = (await response.json()) as {
      _embedded?: { authorizationPolicies?: unknown[] };
      authorizationPolicies?: unknown[];
      _links?: { next?: { href?: unknown } };
    };
    const page = body._embedded?.authorizationPolicies ?? body.authorizationPolicies ?? [];
    rows.push(...page.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object').map(mapRemote));
    const next = body._links?.next?.href;
    url = typeof next === 'string' && next.startsWith('http') ? next : null;
  }
  return rows;
}

export async function createRemotePolicy(
  config: EnterpriseConfig,
  accessToken: string,
  policy: AuthorizePolicy,
  client: AuthorizeClient,
): Promise<string> {
  const response = await client.request(authorizationPoliciesUrl(config), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(remotePolicyBody(policy)),
  });
  if (response.status === 409) throw new PolicyConflictError(await errorText(response, 'PingOne already has that authorization policy'));
  if (!response.ok) throw new Error(await errorText(response, 'PingOne did not create the authorization policy'));
  const body = (await response.json()) as { id?: unknown };
  if (typeof body.id !== 'string' || !body.id) throw new Error('PingOne did not return a policy id.');
  return body.id;
}

export class PolicyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyConflictError';
  }
}

export async function syncRemoteScaffold(
  config: EnterpriseConfig,
  accessToken: string,
  policies: AuthorizePolicy[],
  client: AuthorizeClient,
  onProgress?: (policy: AuthorizePolicy) => void,
  shouldContinue: () => boolean = () => true,
): Promise<{ policies: AuthorizePolicy[]; created: AuthorizePolicy[] }> {
  return client.run(async () => {
    let remote = await listRemotePolicies(config, accessToken, client);
    const created: AuthorizePolicy[] = [];
    const next: AuthorizePolicy[] = [];
    const keep = (policy: AuthorizePolicy, posted: boolean) => {
      next.push(policy);
      if (posted) created.push(policy);
      onProgress?.(policy);
    };
    for (let index = 0; index < policies.length; index += 1) {
      if (!shouldContinue()) break;
      const policy = policies[index];
      if (!policy) continue;
      const existing = matchRemote(policy, remote);
      if (existing) {
        if (!shouldContinue()) break;
        keep({ ...policy, remoteId: existing.id, enabled: existing.enabled }, false);
        continue;
      }
      try {
        const remoteId = await createRemotePolicy(config, accessToken, policy, client);
        if (!shouldContinue()) break;
        const saved = { ...policy, remoteId };
        keep(saved, true);
        remote = [
          ...remote,
          {
            id: remoteId,
            name: policy.name,
            description: String(remotePolicyBody(policy).description ?? ''),
            enabled: policy.enabled,
            updatedAt: policy.updatedAt,
          },
        ];
        const laterNeedsPost = policies.slice(index + 1).some((item) => !matchRemote(item, remote));
        if (laterNeedsPost) await client.paceAfterManagementPost();
      } catch (error) {
        if (!(error instanceof PolicyConflictError)) throw error;
        remote = await listRemotePolicies(config, accessToken, client);
        const found = matchRemote(policy, remote);
        if (!found) throw error;
        keep({ ...policy, remoteId: found.id, enabled: found.enabled }, false);
      }
    }
    return { policies: next, created };
  });
}

export async function setRemotePolicyEnabled(
  config: EnterpriseConfig,
  accessToken: string,
  remoteId: string,
  enabled: boolean,
  client: AuthorizeClient,
): Promise<void> {
  await client.run(async () => {
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' };
    const current = await client.request(authorizationPoliciesUrl(config, remoteId), { headers });
    if (!current.ok) throw new Error(await errorText(current, 'PingOne did not return that policy'));
    const body = (await current.json()) as Record<string, unknown>;
    const response = await client.request(authorizationPoliciesUrl(config, remoteId), {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...body, enabled }),
    });
    if (!response.ok) throw new Error(await errorText(response, 'PingOne did not update that policy'));
  });
}

export async function postDecision(
  config: EnterpriseConfig,
  accessToken: string,
  input: DecisionCall,
  client: AuthorizeClient,
): Promise<unknown> {
  const response = await client.request(decisionUrl(config), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(decisionParameters(input)),
  });
  if (!response.ok) throw new Error(await errorText(response, 'PingOne Authorize did not return a decision'));
  return response.json();
}

function matchRemote(policy: AuthorizePolicy, remote: RemotePolicy[]): RemotePolicy | undefined {
  return remote.find((item) => item.id === policy.remoteId || item.name === policy.name || item.description.includes(policy.id));
}

function mapRemote(row: Record<string, unknown>): { id: string; name: string; description: string; enabled: boolean; updatedAt: number | null } {
  const updated = row.updatedAt ?? row.updated;
  const updatedAt = typeof updated === 'string' ? Date.parse(updated) : typeof updated === 'number' ? updated : null;
  return {
    id: typeof row.id === 'string' ? row.id : '',
    name: typeof row.name === 'string' ? row.name : 'Policy',
    description: typeof row.description === 'string' ? row.description : '',
    enabled: row.enabled !== false,
    updatedAt: updatedAt !== null && Number.isFinite(updatedAt) ? updatedAt : null,
  };
}

async function errorText(response: Response, fallback: string): Promise<string> {
  const text = (await response.text()).trim();
  return text ? `${fallback} (${response.status}): ${text}` : `${fallback} (${response.status}).`;
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, '');
}
