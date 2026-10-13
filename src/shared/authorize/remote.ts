import type { EnterpriseConfig } from '../config';
import { FEATURE_STATEMENT, SCAFFOLD_MARKER, type AuthorizePolicy, decisionParameters, type DecisionInput } from './policy';

export function authorizationPoliciesUrl(config: EnterpriseConfig, id?: string): string {
  const base = `${trimSlash(config.tenant.apiHost)}/v1/environments/${config.tenant.environmentId}/authorizationPolicies`;
  return id ? `${base}/${id}` : base;
}

export function decisionUrl(config: EnterpriseConfig): string {
  return `${trimSlash(config.tenant.apiHost)}/v1/environments/${config.tenant.environmentId}/decisionEndpoints/${config.authorize.decisionEndpointId}`;
}

export function remotePolicyBody(policy: AuthorizePolicy): Record<string, unknown> {
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

export async function listRemotePolicies(
  config: EnterpriseConfig,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<{ id: string; name: string; description: string; enabled: boolean; updatedAt: number | null }[]> {
  const response = await fetchImpl(authorizationPoliciesUrl(config), {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(await errorText(response, 'PingOne did not list authorization policies'));
  const body = (await response.json()) as { _embedded?: { authorizationPolicies?: unknown[] }; authorizationPolicies?: unknown[] };
  const rows = body._embedded?.authorizationPolicies ?? body.authorizationPolicies ?? [];
  return rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object').map(mapRemote);
}

export async function createRemotePolicy(
  config: EnterpriseConfig,
  accessToken: string,
  policy: AuthorizePolicy,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(authorizationPoliciesUrl(config), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(remotePolicyBody(policy)),
  });
  if (!response.ok) throw new Error(await errorText(response, 'PingOne did not create the authorization policy'));
  const body = (await response.json()) as { id?: unknown };
  if (typeof body.id !== 'string' || !body.id) throw new Error('PingOne did not return a policy id.');
  return body.id;
}

export async function setRemotePolicyEnabled(
  config: EnterpriseConfig,
  accessToken: string,
  remoteId: string,
  enabled: boolean,
  fetchImpl: typeof fetch,
): Promise<void> {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  const current = await fetchImpl(authorizationPoliciesUrl(config, remoteId), { headers });
  if (!current.ok) throw new Error(await errorText(current, 'PingOne did not return that policy'));
  const body = (await current.json()) as Record<string, unknown>;
  const response = await fetchImpl(authorizationPoliciesUrl(config, remoteId), {
    method: 'PUT',
    headers,
    body: JSON.stringify({ ...body, enabled }),
  });
  if (!response.ok) throw new Error(await errorText(response, 'PingOne did not update that policy'));
}

export async function postDecision(
  config: EnterpriseConfig,
  accessToken: string,
  input: DecisionInput & { userId: string; username: string },
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(decisionUrl(config), {
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
