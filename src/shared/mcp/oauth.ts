import { createPkce } from '../auth/pkce';
import { redactSecrets } from '../env';
import type { SecretStore } from '../secrets';
import type { McpAuthStep } from '../types';

export interface StoredMcpTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  tokenType: string;
  issuer: string;
  resource: string;
}

export interface StoredMcpClient {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  issuer: string;
  source: 'dcr' | 'manual' | 'cimd';
}

export class McpOauthError extends Error {
  constructor(
    message: string,
    readonly steps: McpAuthStep[],
    readonly needsClient = false,
  ) {
    super(message);
    this.name = 'McpOauthError';
  }
}

export function mcpOauthTokenAccount(extensionId: string): string {
  return `mcp-oauth-tokens:${extensionId}`;
}

export function mcpOauthClientAccount(issuer: string): string {
  return `mcp-oauth-client:${encodeURIComponent(issuer)}`;
}

export function mcpEnvAccount(extensionId: string, name: string): string {
  return `mcp-env:${extensionId}:${name}`;
}

export function parseWwwAuthenticate(header: string | null): Record<string, string> {
  if (!header) return {};
  const params: Record<string, string> = {};
  const pattern = /([A-Za-z0-9_!#$%&'*+.^`|~-]+)=(?:"([^"]*)"|([^\s,]+))/g;
  for (const match of header.matchAll(pattern)) {
    params[(match[1] ?? '').toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return params;
}

export function protectedResourceMetadataUrls(serverUrl: string, resourceMetadata?: string): string[] {
  const resource = new URL(serverUrl);
  const urls: string[] = [];
  if (resourceMetadata) urls.push(new URL(resourceMetadata).toString());
  const pathname = resource.pathname.endsWith('/') && resource.pathname !== '/' ? resource.pathname.slice(0, -1) : resource.pathname;
  if (pathname && pathname !== '/') {
    urls.push(new URL(`/.well-known/oauth-protected-resource${pathname}`, resource.origin).toString());
  }
  urls.push(new URL('/.well-known/oauth-protected-resource', resource.origin).toString());
  return [...new Set(urls)];
}

export function authorizationServerMetadataUrls(issuer: string): Array<{ url: string; kind: 'oauth' | 'oidc' }> {
  const url = new URL(issuer);
  const pathname = url.pathname.endsWith('/') && url.pathname !== '/' ? url.pathname.slice(0, -1) : url.pathname;
  if (!pathname || pathname === '/') {
    return [
      { url: new URL('/.well-known/oauth-authorization-server', url.origin).toString(), kind: 'oauth' },
      { url: new URL('/.well-known/openid-configuration', url.origin).toString(), kind: 'oidc' },
    ];
  }
  return [
    { url: new URL(`/.well-known/oauth-authorization-server${pathname}`, url.origin).toString(), kind: 'oauth' },
    { url: new URL(`${pathname}/.well-known/oauth-authorization-server`, url.origin).toString(), kind: 'oauth' },
    { url: new URL(`/.well-known/openid-configuration${pathname}`, url.origin).toString(), kind: 'oidc' },
    { url: new URL(`${pathname}/.well-known/openid-configuration`, url.origin).toString(), kind: 'oidc' },
  ];
}

export interface RunMcpAuthorizationInput {
  extensionId: string;
  serverUrl: string;
  secrets: SecretStore;
  openBrowser: (url: string) => Promise<void>;
  beginLoopback: (
    state: string,
    port: number | undefined,
    signal: AbortSignal,
  ) => Promise<{ redirectUri: string; result: Promise<{ code: string; state: string }> }>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  manualClient?: { clientId: string; clientSecret?: string };
  clientMetadataUrl?: string;
  stepUpScope?: string;
}

interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  client_id_metadata_document_supported?: boolean;
}

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

export async function runMcpAuthorization(input: RunMcpAuthorizationInput): Promise<{ tokens: StoredMcpTokens; steps: McpAuthStep[] }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const steps: McpAuthStep[] = [];
  const secretsSeen: string[] = [];
  const note = (step: McpAuthStep) => {
    steps.push({ ...step, detail: redactOauthText(step.detail, secretsSeen) });
  };
  const fail = (message: string, needsClient = false): never => {
    throw new McpOauthError(message, steps, needsClient);
  };

  try {
    let existing = await readTokens(input.secrets, input.extensionId);
    if (existing && !input.stepUpScope && existing.expiresAt <= now() + 60_000 && existing.refreshToken) {
      try {
        const refreshed = await refreshStoredMcpToken({
          extensionId: input.extensionId,
          secrets: input.secrets,
          fetchImpl,
          now,
        });
        if (refreshed) {
          secretsSeen.push(refreshed.accessToken);
          if (refreshed.refreshToken) secretsSeen.push(refreshed.refreshToken);
          note({
            kind: 'refresh',
            title: 'Refresh',
            detail: 'Refreshed the access token. access_token=[redacted].',
            ok: true,
          });
          existing = refreshed;
        }
      } catch {
        existing = null;
      }
    }
    if (existing && !input.stepUpScope && existing.expiresAt > now() + 60_000) {
      const probe = await probeResource(fetchImpl, input.serverUrl, existing.accessToken);
      if (probe.status === 403 && probe.params.error === 'insufficient_scope') {
        note(stepUpStep(probe.params.scope));
        return finish(await authorizeFromDiscovery(probe, existing.scope));
      }
      if (probe.status !== 401) {
        note({
          kind: 'token',
          title: 'Token',
          detail: 'The server accepted the stored access token.',
          ok: true,
        });
        return { tokens: existing, steps };
      }
    }

    const challenge = await probeResource(fetchImpl, input.serverUrl);
    if (challenge.status === 403 && challenge.params.error === 'insufficient_scope') {
      note(stepUpStep(challenge.params.scope));
    } else if (challenge.status === 401) {
      note({
        kind: 'unauthorized',
        title: '401 Unauthorized',
        detail: `WWW-Authenticate resource_metadata=${challenge.params.resource_metadata || 'absent'}; scope=${challenge.params.scope || 'absent'}.`,
        ok: true,
      });
    } else if (!input.stepUpScope) {
      fail(`The MCP server did not request authorization (HTTP ${challenge.status}).`);
    } else {
      note(stepUpStep(input.stepUpScope));
    }

    return finish(await authorizeFromDiscovery(challenge, existing?.scope));
  } catch (error) {
    if (error instanceof McpOauthError) throw error;
    throw new McpOauthError(error instanceof Error ? error.message : String(error), steps);
  }

  async function finish(tokens: StoredMcpTokens): Promise<{ tokens: StoredMcpTokens; steps: McpAuthStep[] }> {
    await input.secrets.set(mcpOauthTokenAccount(input.extensionId), JSON.stringify(tokens));
    return { tokens, steps };
  }

  async function authorizeFromDiscovery(
    challenge: ProbeResult,
    previousScope: string | undefined,
  ): Promise<StoredMcpTokens> {
    const resourceDoc = await loadProtectedResource(fetchImpl, input.serverUrl, challenge.params.resource_metadata);
    note({
      kind: 'protected-resource',
      title: 'Protected resource metadata',
      detail: `Fetched ${resourceDoc.url}. resource=${resourceDoc.body.resource ?? input.serverUrl}; authorization_servers=${(resourceDoc.body.authorization_servers ?? []).join(' ') || 'none'}; scopes_supported=${(resourceDoc.body.scopes_supported ?? []).join(' ') || 'none'}.`,
      ok: true,
    });
    const issuers = resourceDoc.body.authorization_servers?.filter((value) => typeof value === 'string' && value) ?? [];
    if (issuers.length === 0) issuers.push(new URL(input.serverUrl).origin);
    let metadata: AuthorizationServerMetadata | null = null;
    let metadataUrl = '';
    let issuer = issuers[0] ?? new URL(input.serverUrl).origin;
    for (const candidate of issuers) {
      const found = await loadAuthorizationServer(fetchImpl, candidate);
      if (found) {
        metadata = found.body;
        metadataUrl = found.url;
        issuer = candidate;
        break;
      }
    }
    if (!metadata || !metadata.authorization_endpoint || !metadata.token_endpoint) {
      throw new McpOauthError('Authorization server metadata did not include authorization and token endpoints.', steps);
    }
    const resolved: AuthorizationServerMetadata = metadata;
    note({
      kind: 'authorization-server',
      title: 'Authorization server metadata',
      detail: `Fetched ${metadataUrl}. issuer=${resolved.issuer}; authorization_endpoint=${resolved.authorization_endpoint}; token_endpoint=${resolved.token_endpoint}; registration_endpoint=${resolved.registration_endpoint ?? 'none'}; client_id_metadata_document_supported=${Boolean(resolved.client_id_metadata_document_supported)}.`,
      ok: true,
    });

    const scope = selectScope(input.stepUpScope, challenge.params.scope, previousScope, resourceDoc.body.scopes_supported);
    const resource = resourceDoc.body.resource || input.serverUrl;
    let client = await readClient(input.secrets, issuer);
    if (input.manualClient?.clientId) {
      client = {
        clientId: input.manualClient.clientId,
        clientSecret: input.manualClient.clientSecret,
        redirectUri: client?.redirectUri ?? '',
        issuer,
        source: 'manual',
      };
    }
    const obtainClient = async (redirectUri: string): Promise<StoredMcpClient> => {
      const sameRedirect = !client?.redirectUri || client.redirectUri === redirectUri;
      if (client?.clientId && (client.source !== 'dcr' || sameRedirect)) return { ...client, redirectUri };
      if (client?.source === 'dcr') {
        await input.secrets.delete(mcpOauthClientAccount(issuer));
        client = null;
        note({
          kind: 'registration',
          title: 'Registration',
          detail: 'The loopback redirect changed, so the saved client cannot be reused. Registering again.',
          ok: true,
        });
      }
      const created = await registerClient(resolved, redirectUri, issuer);
      client = created;
      await input.secrets.set(mcpOauthClientAccount(issuer), JSON.stringify(created));
      return created;
    };

    const tokens = await browserGrant(resolved, issuer, resource, scope, obtainClient, false);
    if (tokens) return tokens;
    if (client?.source === 'dcr') {
      await input.secrets.delete(mcpOauthClientAccount(issuer));
      client = null;
      note({
        kind: 'registration',
        title: 'Registration',
        detail: 'The authorization server rejected the client. Registering again.',
        ok: true,
      });
      const retried = await browserGrant(resolved, issuer, resource, scope, obtainClient, true);
      if (retried) return retried;
    }
    throw new McpOauthError('The token endpoint rejected the authorization code.', steps);
  }

  async function registerClient(
    metadata: AuthorizationServerMetadata,
    redirectUri: string,
    issuer: string,
  ): Promise<StoredMcpClient> {
    if (metadata.client_id_metadata_document_supported && input.clientMetadataUrl) {
      const metadataUrl = input.clientMetadataUrl;
      if (!metadataUrl.startsWith('https://') || new URL(metadataUrl).pathname === '/') {
        fail('A client ID metadata document must be an HTTPS URL with a path.');
      }
      note({
        kind: 'registration',
        title: 'Registration',
        detail: `Using client ID metadata document ${metadataUrl}.`,
        ok: true,
      });
      return { clientId: metadataUrl, redirectUri, issuer, source: 'cimd' };
    }
    if (input.manualClient?.clientId) {
      note({
        kind: 'registration',
        title: 'Registration',
        detail: `Using the client id entered for this authorization server (${input.manualClient.clientId}).`,
        ok: true,
      });
      return {
        clientId: input.manualClient.clientId,
        clientSecret: input.manualClient.clientSecret,
        redirectUri,
        issuer,
        source: 'manual',
      };
    }
    const registrationEndpoint = metadata.registration_endpoint;
    if (!registrationEndpoint) {
      note({
        kind: 'registration',
        title: 'Registration',
        detail: 'This authorization server has no registration endpoint and does not advertise client ID metadata documents.',
        ok: false,
      });
      throw new McpOauthError('This authorization server does not support dynamic registration. Enter a client ID.', steps, true);
    }
    const response = await fetchImpl(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Enterprise Agent',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      client_id?: string;
      client_secret?: string;
      error?: string;
    };
    const clientId = body.client_id;
    if (!response.ok || !clientId) {
      throw new McpOauthError(body.error || `Dynamic client registration failed (HTTP ${response.status}).`, steps);
    }
    if (body.client_secret) secretsSeen.push(body.client_secret);
    note({
      kind: 'registration',
      title: 'Registration',
      detail: `Registered client_id=${clientId}. client_secret=${body.client_secret ? '[redacted]' : 'none'}.`,
      ok: true,
    });
    return {
      clientId,
      clientSecret: body.client_secret,
      redirectUri,
      issuer,
      source: 'dcr',
    };
  }

  async function browserGrant(
    metadata: AuthorizationServerMetadata,
    issuer: string,
    resource: string,
    scope: string | undefined,
    obtainClient: (redirectUri: string) => Promise<StoredMcpClient>,
    forceNewPort: boolean,
  ): Promise<StoredMcpTokens | null> {
    const pkce = await createPkce();
    secretsSeen.push(pkce.verifier);
    const cached = await readClient(input.secrets, issuer);
    const preferredPort = forceNewPort ? undefined : portOf(cached?.redirectUri);
    const loop = (preferredPort ? await listen(pkce.state, preferredPort) : null) ?? (await listen(pkce.state));
    if (!loop) throw new McpOauthError('Could not open a loopback redirect.', steps);
    const redirectUri = loop.redirectUri;
    let oauthClient: StoredMcpClient;
    try {
      oauthClient = await obtainClient(redirectUri);
    } catch (error) {
      loop.abort();
      await loop.result.catch(() => undefined);
      throw error;
    }
    if (oauthClient.clientSecret) secretsSeen.push(oauthClient.clientSecret);
    if (!oauthClient.redirectUri) oauthClient = { ...oauthClient, redirectUri };
    if (cached && cached.clientId === oauthClient.clientId && !forceNewPort && steps.every((step) => step.kind !== 'registration' || !step.detail.startsWith('Reused'))) {
      const already = steps.some((step) => step.detail.includes(`Reused client_id=${oauthClient.clientId}`));
      if (!already && oauthClient.source !== 'manual') {
        note({
          kind: 'registration',
          title: 'Registration',
          detail: `Reused client_id=${oauthClient.clientId}.`,
          ok: true,
        });
      }
    }
    await input.secrets.set(mcpOauthClientAccount(issuer), JSON.stringify({ ...oauthClient, redirectUri, issuer }));
    const authorize = new URL(metadata.authorization_endpoint!);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', oauthClient.clientId);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('code_challenge', pkce.challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('state', pkce.state);
    authorize.searchParams.set('resource', resource);
    if (scope) authorize.searchParams.set('scope', scope);
    note({
      kind: 'authorize',
      title: 'Authorize',
      detail: `Opened the system browser. PKCE S256, resource=${resource}, scope=${scope || 'none'}. The redirect state is checked before the code is exchanged.`,
      ok: true,
    });
    try {
      await input.openBrowser(authorize.toString());
      const result = await loop.result;
      if (result.state !== pkce.state) fail('The sign-in response failed the state check.');
      secretsSeen.push(result.code);
      const tokenResponse = await requestToken(fetchImpl, metadata, oauthClient, {
        grant_type: 'authorization_code',
        code: result.code,
        redirect_uri: redirectUri,
        code_verifier: pkce.verifier,
        resource,
      });
      if (tokenResponse.error === 'invalid_client') return null;
      if (tokenResponse.error || !tokenResponse.access_token) {
        fail(tokenResponse.error_description || tokenResponse.error || 'Token exchange failed.');
      }
      return rememberToken(tokenResponse, issuer, resource, scope, now);
    } catch (error) {
      loop.abort();
      await loop.result.catch(() => undefined);
      throw error;
    }
  }

  function rememberToken(
    tokenResponse: TokenResponse,
    issuer: string,
    resource: string,
    scope: string | undefined,
    clock: () => number,
  ): StoredMcpTokens {
    if (tokenResponse.access_token) secretsSeen.push(tokenResponse.access_token);
    if (tokenResponse.refresh_token) secretsSeen.push(tokenResponse.refresh_token);
    const expiresIn = tokenResponse.expires_in ?? 3600;
    note({
      kind: 'token',
      title: 'Token',
      detail: `Exchanged the authorization code. token_type=${tokenResponse.token_type ?? 'Bearer'}, expires_in=${expiresIn}, scope=${tokenResponse.scope || scope || 'none'}. access_token=[redacted], refresh_token=${tokenResponse.refresh_token ? '[redacted]' : 'none'}.`,
      ok: true,
    });
    return {
      accessToken: tokenResponse.access_token!,
      refreshToken: tokenResponse.refresh_token,
      expiresAt: clock() + expiresIn * 1000,
      scope: tokenResponse.scope || scope,
      tokenType: tokenResponse.token_type ?? 'Bearer',
      issuer,
      resource,
    };
  }

  async function listen(state: string, port?: number) {
    const controller = new AbortController();
    try {
      const loop = await input.beginLoopback(state, port, controller.signal);
      const result = loop.result;
      result.catch(() => undefined);
      return {
        redirectUri: loop.redirectUri,
        result,
        abort: () => controller.abort(),
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (port && (code === 'EADDRINUSE' || code === 'EACCES')) return null;
      throw error;
    }
  }
}

export async function refreshStoredMcpToken(input: {
  extensionId: string;
  secrets: SecretStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<StoredMcpTokens | null> {
  const now = input.now ?? Date.now;
  const current = await readTokens(input.secrets, input.extensionId);
  if (!current) return null;
  if (current.expiresAt > now() + 60_000) return current;
  if (!current.refreshToken) return null;
  const client = await readClient(input.secrets, current.issuer);
  if (!client) return null;
  const metadata = await loadAuthorizationServer(input.fetchImpl ?? fetch, current.issuer);
  if (!metadata?.body.token_endpoint) throw new Error('The authorization server did not publish a token endpoint.');
  const response = await requestToken(input.fetchImpl ?? fetch, metadata.body, client, {
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
    resource: current.resource,
  });
  if (response.error || !response.access_token) {
    throw new Error(response.error_description || response.error || 'Refreshing the MCP access token failed.');
  }
  const next: StoredMcpTokens = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token || current.refreshToken,
    expiresAt: now() + (response.expires_in ?? 3600) * 1000,
    scope: response.scope || current.scope,
    tokenType: response.token_type ?? current.tokenType,
    issuer: current.issuer,
    resource: current.resource,
  };
  await input.secrets.set(mcpOauthTokenAccount(input.extensionId), JSON.stringify(next));
  return next;
}

interface ProbeResult {
  status: number;
  params: Record<string, string>;
}

async function probeResource(fetchImpl: typeof fetch, serverUrl: string, accessToken?: string): Promise<ProbeResult> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const response = await fetchImpl(serverUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'enterprise-agent-client', version: '0.1.0' },
      },
    }),
  });
  await response.text().catch(() => undefined);
  return {
    status: response.status,
    params: parseWwwAuthenticate(response.headers.get('www-authenticate')),
  };
}

async function loadProtectedResource(
  fetchImpl: typeof fetch,
  serverUrl: string,
  resourceMetadata: string | undefined,
): Promise<{ url: string; body: ProtectedResourceMetadata }> {
  let lastError = 'Protected resource metadata was not found.';
  for (const url of protectedResourceMetadataUrls(serverUrl, resourceMetadata)) {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      await response.text().catch(() => undefined);
      lastError = `HTTP ${response.status} from ${url}`;
      continue;
    }
    const body = (await response.json()) as ProtectedResourceMetadata;
    return { url, body };
  }
  throw new Error(lastError);
}

async function loadAuthorizationServer(
  fetchImpl: typeof fetch,
  issuer: string,
): Promise<{ url: string; body: AuthorizationServerMetadata } | null> {
  for (const candidate of authorizationServerMetadataUrls(issuer)) {
    const response = await fetchImpl(candidate.url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      await response.text().catch(() => undefined);
      continue;
    }
    const body = (await response.json()) as AuthorizationServerMetadata;
    const expected = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
    const actual = body.issuer?.endsWith('/') ? body.issuer.slice(0, -1) : body.issuer;
    if (actual !== expected) continue;
    return { url: candidate.url, body };
  }
  return null;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function requestToken(
  fetchImpl: typeof fetch,
  metadata: AuthorizationServerMetadata,
  client: StoredMcpClient,
  fields: Record<string, string>,
): Promise<TokenResponse> {
  const body = new URLSearchParams(fields);
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  const methods = metadata.token_endpoint_auth_methods_supported ?? [];
  const secret = client.clientSecret;
  if (secret && (methods.length === 0 || methods.includes('client_secret_basic'))) {
    headers.Authorization = `Basic ${Buffer.from(`${client.clientId}:${secret}`).toString('base64')}`;
  } else if (secret && methods.includes('client_secret_post')) {
    body.set('client_id', client.clientId);
    body.set('client_secret', secret);
  } else {
    body.set('client_id', client.clientId);
  }
  const response = await fetchImpl(metadata.token_endpoint!, { method: 'POST', headers, body });
  return (await response.json().catch(() => ({}))) as TokenResponse;
}

function selectScope(
  stepUp: string | undefined,
  challenged: string | undefined,
  previous: string | undefined,
  supported: string[] | undefined,
): string | undefined {
  const parts = [previous, stepUp ?? challenged ?? (supported?.length ? supported.join(' ') : undefined)];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const part of parts) {
    for (const token of (part ?? '').split(/\s+/)) {
      if (!token || seen.has(token)) continue;
      seen.add(token);
      ordered.push(token);
    }
  }
  return ordered.length ? ordered.join(' ') : undefined;
}

function portOf(redirectUri: string | undefined): number | undefined {
  if (!redirectUri) return undefined;
  try {
    const port = Number(new URL(redirectUri).port);
    return port || undefined;
  } catch {
    return undefined;
  }
}

function stepUpStep(scope: string | undefined): McpAuthStep {
  return {
    kind: 'step-up',
    title: 'Insufficient scope',
    detail: `403 insufficient_scope. Requesting a new authorization code for scope ${scope || 'the challenged scope'} instead of refreshing.`,
    ok: true,
  };
}

async function readTokens(secrets: SecretStore, extensionId: string): Promise<StoredMcpTokens | null> {
  const raw = await secrets.get(mcpOauthTokenAccount(extensionId));
  if (!raw) return null;
  return JSON.parse(raw) as StoredMcpTokens;
}

async function readClient(secrets: SecretStore, issuer: string): Promise<StoredMcpClient | null> {
  const raw = await secrets.get(mcpOauthClientAccount(issuer));
  if (!raw) return null;
  return JSON.parse(raw) as StoredMcpClient;
}

export function redactOauthText(text: string, secrets: string[] = []): string {
  let next = redactSecrets(text);
  for (const secret of secrets) {
    if (secret.length >= 8) next = next.split(secret).join('[redacted]');
  }
  return next;
}
