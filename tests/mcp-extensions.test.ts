import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { beginLoopback } from '../src/shared/auth/loopback';
import { parseEnterpriseConfig } from '../src/shared/config';
import { joinCommandLine, splitCommandLine } from '../src/shared/mcp/command';
import {
  authorizationServerMetadataUrls,
  mcpOauthClientAccount,
  mcpOauthTokenAccount,
  protectedResourceMetadataUrls,
  refreshStoredMcpToken,
  runMcpAuthorization,
  McpOauthError,
  type StoredMcpTokens,
} from '../src/shared/mcp/oauth';
import { commandPath } from '../src/shared/mcp/path';
import { MemorySecretStore } from '../src/shared/secrets';
import { Repository } from '../src/main/db';
import { Runtime } from '../src/main/runtime';
import { parseBranding } from '../src/shared/branding';

describe('extension config', () => {
  it('keeps an old mcpServers entry and fills Goose defaults', () => {
    const parsed = parseEnterpriseConfig(JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')));
    const echo = parsed.mcpServers[0];
    expect(echo?.id).toBe('echo');
    expect(echo?.type).toBe('stdio');
    expect(echo?.transport).toBe('stdio');
    expect(echo?.command).toBe('node');
    expect(echo?.args).toEqual(['examples/echo-mcp-server.mjs']);
    expect(echo?.audience).toBe('https://mcp.local.echo');
    expect(echo?.scope).toBe('mcp:tools');
    expect(echo?.timeout).toBe(300);
    expect(echo?.enabled).toBe(true);
    expect(echo?.envKeys).toEqual([]);
  });

  it('normalizes a Goose-style HTTP extension', () => {
    const raw = JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')) as { mcpServers: unknown[] };
    raw.mcpServers.push({
      id: 'docs',
      name: 'Docs',
      type: 'streamable_http',
      uri: 'https://docs.example/mcp',
      cmd: 'ignored',
      headers: { 'X-Test': '1' },
      env_keys: ['DOC_TOKEN'],
      timeout: 120,
      enabled: false,
      description: 'Docs server',
    });
    const docs = parseEnterpriseConfig(raw).mcpServers.find((server) => server.id === 'docs');
    expect(docs).toMatchObject({
      type: 'streamable_http',
      transport: 'http',
      url: 'https://docs.example/mcp',
      command: 'ignored',
      headers: { 'X-Test': '1' },
      envKeys: ['DOC_TOKEN'],
      timeout: 120,
      enabled: false,
      description: 'Docs server',
      audience: '',
    });
  });

  it('refuses environment values in enterprise.json', () => {
    const raw = JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')) as {
      mcpServers: Array<Record<string, unknown>>;
    };
    raw.mcpServers[0] = { ...raw.mcpServers[0], envs: { FOO: 'bar' } };
    expect(() => parseEnterpriseConfig(raw)).toThrow(/envKeys/);
  });
});

describe('command line and PATH', () => {
  it('splits a quoted command and joins it back', () => {
    expect(splitCommandLine('npx -y "@scope/pkg"')).toEqual({ command: 'npx', args: ['-y', '@scope/pkg'] });
    expect(joinCommandLine('npx', ['-y', '@scope/pkg'])).toBe('npx -y @scope/pkg');
    expect(joinCommandLine('node', ['my script.js'])).toBe('node "my script.js"');
  });

  it('prefixes the macOS GUI PATH and leaves other platforms alone', () => {
    const darwin = commandPath('darwin', '/usr/bin:/bin:/opt/homebrew/bin', '/Users/ada');
    expect(darwin.startsWith('/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:')).toBe(true);
    expect(darwin).toContain('/Users/ada/.local/bin');
    expect(darwin.split(':').filter((entry) => entry === '/opt/homebrew/bin')).toHaveLength(1);
    expect(darwin).toContain('/usr/bin');
    expect(commandPath('linux', '/usr/bin:/bin', '/home/ada')).toBe('/usr/bin:/bin');
  });
});

describe('MCP authorization', () => {
  it('builds protected-resource and path-aware authorization-server URLs', () => {
    expect(protectedResourceMetadataUrls('https://mcp.example/public/mcp', 'https://mcp.example/custom')).toEqual([
      'https://mcp.example/custom',
      'https://mcp.example/.well-known/oauth-protected-resource/public/mcp',
      'https://mcp.example/.well-known/oauth-protected-resource',
    ]);
    expect(authorizationServerMetadataUrls('https://as.example/tenant').map((item) => item.url)).toEqual([
      'https://as.example/.well-known/oauth-authorization-server/tenant',
      'https://as.example/tenant/.well-known/oauth-authorization-server',
      'https://as.example/.well-known/openid-configuration/tenant',
      'https://as.example/tenant/.well-known/openid-configuration',
    ]);
  });

  it('runs discovery, DCR, PKCE, and reuse, and redacts secrets', async () => {
    const harness = await startHarness();
    const secrets = new MemorySecretStore();
    try {
      const first = await authorize(harness, secrets);
      expect(first.steps.map((step) => step.kind)).toEqual([
        'unauthorized',
        'protected-resource',
        'authorization-server',
        'registration',
        'authorize',
        'token',
      ]);
      expect(JSON.stringify(first.steps)).not.toContain(first.tokens.accessToken);
      expect(JSON.stringify(first.steps)).not.toContain('secret-value');
      expect(harness.authorizeUrls[0]).toContain('code_challenge_method=S256');
      expect(harness.authorizeUrls[0]).toContain(`resource=${encodeURIComponent(harness.mcpUrl)}`);
      expect(harness.counts.register).toBe(1);
      const issuer = harness.origin;
      const storedClient = JSON.parse((await secrets.get(mcpOauthClientAccount(issuer))) ?? '{}') as { clientSecret?: string };
      expect(storedClient.clientSecret).toContain('secret-value');

      await secrets.delete(mcpOauthTokenAccount('docs'));
      const second = await authorize(harness, secrets);
      expect(harness.counts.register).toBe(1);
      expect(second.steps.some((step) => step.detail.includes('Reused client_id='))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('refreshes an expired access token without a new authorization', async () => {
    const harness = await startHarness();
    const secrets = new MemorySecretStore();
    try {
      const first = await authorize(harness, secrets);
      const expired: StoredMcpTokens = { ...first.tokens, expiresAt: 0 };
      await secrets.set(mcpOauthTokenAccount('docs'), JSON.stringify(expired));
      const refreshed = await refreshStoredMcpToken({ extensionId: 'docs', secrets, now: () => 1_000 });
      expect(refreshed?.accessToken).toBeTruthy();
      expect(refreshed?.accessToken).not.toBe(first.tokens.accessToken);
      expect(harness.counts.refresh).toBe(1);
      expect(harness.counts.authorize).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it('step-up uses a new authorization code instead of refresh', async () => {
    const harness = await startHarness();
    const secrets = new MemorySecretStore();
    try {
      await authorize(harness, secrets);
      harness.requireScope = 'mcp:write';
      const stepped = await authorize(harness, secrets);
      expect(stepped.steps[0]?.kind).toBe('step-up');
      expect(stepped.tokens.scope).toContain('mcp:write');
      expect(stepped.tokens.scope).toContain('mcp:read');
      expect(harness.counts.refresh).toBe(0);
      expect(harness.counts.authorize).toBe(2);
      expect(harness.authorizeUrls.at(-1)).toContain('mcp%3Awrite');
    } finally {
      await harness.close();
    }
  });

  it('re-registers when the authorization server rejects the client', async () => {
    const harness = await startHarness({ rejectOnce: true });
    const secrets = new MemorySecretStore();
    try {
      const outcome = await authorize(harness, secrets);
      expect(outcome.tokens.accessToken).toBeTruthy();
      expect(harness.counts.register).toBe(2);
      expect(outcome.steps.some((step) => step.detail.includes('Registering again'))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('asks for a manual client when dynamic registration is unavailable', async () => {
    const harness = await startHarness({ noDcr: true });
    const secrets = new MemorySecretStore();
    try {
      await expect(authorize(harness, secrets)).rejects.toBeInstanceOf(McpOauthError);
      const outcome = await authorize(harness, secrets, { clientId: 'hand-issued', clientSecret: 'hand-secret-value' });
      expect(harness.counts.register).toBe(0);
      expect(harness.authorizeUrls.at(-1)).toContain('client_id=hand-issued');
      expect(JSON.stringify(outcome.steps)).not.toContain('hand-secret-value');
    } finally {
      await harness.close();
    }
  });

  it('uses a client ID metadata document when the authorization server advertises it', async () => {
    const harness = await startHarness({ cimd: true });
    const secrets = new MemorySecretStore();
    try {
      const outcome = await authorize(harness, secrets, undefined, 'https://client.example/app/client.json');
      expect(harness.counts.register).toBe(0);
      expect(outcome.steps.some((step) => step.detail.includes('client ID metadata document'))).toBe(true);
      expect(harness.authorizeUrls.at(-1)).toContain(encodeURIComponent('https://client.example/app/client.json'));
    } finally {
      await harness.close();
    }
  });

  it('prefers resource_metadata and falls through path-aware OpenID discovery', async () => {
    const header = await startHarness({ metadataFromHeader: true });
    const secrets = new MemorySecretStore();
    try {
      await authorize(header, secrets);
      expect(header.paths.some((path) => path === '/custom-prm')).toBe(true);
      expect(header.paths.includes('/.well-known/oauth-protected-resource')).toBe(false);
    } finally {
      await header.close();
    }

    const oidc = await startHarness({ pathIssuer: true });
    const second = new MemorySecretStore();
    try {
      await authorize(oidc, second);
      expect(oidc.paths).toContain('/.well-known/oauth-authorization-server/tenant');
      expect(oidc.paths).toContain('/tenant/.well-known/openid-configuration');
    } finally {
      await oidc.close();
    }
  });
});

describe('extension runtime', () => {
  it('preserves a configured audience, stores env in the keychain, and skips exchange when audience is empty', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ext-token-'));
    const withAudience = join(directory, 'audience.txt');
    const withoutAudience = join(directory, 'plain.txt');
    const script = join(directory, 'capture.mjs');
    writeFileSync(script, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], process.env.MCP_ACCESS_TOKEN ?? '');\n");
    const { runtime, db, secrets } = await boot();
    try {
      await runtime.submitCredentials('ada', 'secret', '');
      const echo = db.listMcpServers().find((server) => server.id === 'echo');
      expect(echo?.audience).toBe('https://mcp.local.echo');
      expect(echo?.timeout).toBe(300);
      await runtime.saveMcpServer({
        id: 'echo',
        name: 'Local echo',
        transport: 'stdio',
        command: 'node',
        args: `${script}\n${withAudience}`,
        url: '',
        enabled: true,
      });
      expect(db.listMcpServers().find((server) => server.id === 'echo')?.audience).toBe('https://mcp.local.echo');
      await expect(runtime.connectMcp('echo')).rejects.toThrow(/Connection closed/);
      const exchanged = JSON.parse(Buffer.from(readFileSync(withAudience, 'utf8').split('.')[1] ?? '', 'base64url').toString('utf8')) as {
        aud?: string;
        act?: unknown;
      };
      expect(exchanged.aud).toBe('https://mcp.local.echo');
      expect(exchanged.act).toBeTruthy();

      await runtime.saveMcpServer({
        id: 'plain',
        name: 'Plain',
        transport: 'stdio',
        command: 'node',
        args: `${script}\n${withoutAudience}`,
        url: '',
        audience: '',
        scope: '',
        enabled: true,
        env: [{ name: 'BUILD_NUMBER', value: 'secret-env-value' }],
      });
      await expect(runtime.connectMcp('plain')).rejects.toThrow(/Connection closed/);
      expect(readFileSync(withoutAudience, 'utf8')).toBe('');
      const row = db.listMcpServers().find((server) => server.id === 'plain');
      expect(row?.envKeys).toEqual(['BUILD_NUMBER']);
      expect(JSON.stringify(row)).not.toContain('secret-env-value');
      expect(await secrets.get('mcp-env:plain:BUILD_NUMBER')).toBe('secret-env-value');

      await runtime.saveMcpServer({
        id: 'plain',
        name: 'Plain',
        transport: 'stdio',
        command: 'node',
        args: `${script}\n${withoutAudience}`,
        url: '',
        enabled: true,
        env: [{ name: 'BUILD_NUMBER', value: '' }],
      });
      expect(await secrets.get('mcp-env:plain:BUILD_NUMBER')).toBe('secret-env-value');
    } finally {
      await runtime.dispose();
    }
  });

  it('signs an HTTP extension in, lists its tool, and clears the token on sign-out', async () => {
    const harness = await startHarness();
    const { runtime, secrets } = await boot(async (url) => followAuthorize(url));
    try {
      await runtime.setMockAdmin(true);
      await runtime.submitCredentials('ada', 'secret', '');
      await runtime.saveMcpServer({
        id: 'docs',
        name: 'Docs',
        type: 'streamable_http',
        command: '',
        args: '',
        url: harness.mcpUrl,
        enabled: true,
        timeout: 30,
        headers: [{ name: 'X-Test', value: 'from-dialog' }],
        description: 'Docs server',
      });
      const before = (await runtime.listMcpServers()).find((server) => server.id === 'docs');
      expect(before?.needsSignIn).toBe(true);
      expect(before?.authKind).toBe('oauth');
      const connected = await runtime.signInMcp('docs');
      expect(connected.status).toBe('connected');
      expect(connected.signedIn).toBe(true);
      expect(connected.needsSignIn).toBe(false);
      expect(connected.tools.map((tool) => tool.name)).toContain('ping');
      expect(connected.oauthSteps.map((step) => step.kind)).toContain('token');
      expect(JSON.stringify(connected.oauthSteps)).not.toContain('secret-value');
      const stored = await secrets.get(mcpOauthTokenAccount('docs'));
      expect(stored).toContain('access-');
      expect(JSON.stringify(connected)).not.toContain(JSON.parse(stored ?? '{}').accessToken as string);
      expect(harness.authorizedHeaders.some((headers) => headers['x-test'] === 'from-dialog')).toBe(true);
      const signedOut = await runtime.signOutMcp('docs');
      expect(signedOut.needsSignIn).toBe(true);
      expect(await secrets.get(mcpOauthTokenAccount('docs'))).toBeNull();
    } finally {
      await runtime.dispose();
      await harness.close();
    }
  });
});

async function authorize(
  harness: Harness,
  secrets: MemorySecretStore,
  manualClient?: { clientId: string; clientSecret?: string },
  clientMetadataUrl?: string,
) {
  return runMcpAuthorization({
    extensionId: 'docs',
    serverUrl: harness.mcpUrl,
    secrets,
    manualClient,
    clientMetadataUrl,
    openBrowser: followAuthorize,
    beginLoopback: (state, port, signal) => beginLoopback({ expectedState: state, port, signal }),
  });
}

async function followAuthorize(url: string): Promise<void> {
  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (!location) throw new Error(`The authorize endpoint did not redirect (${response.status}).`);
  const landed = await fetch(location);
  const body = await landed.text();
  if (!landed.ok) throw new Error(`The loopback redirect failed (${landed.status}) at ${location}: ${body}`);
}

interface Harness {
  origin: string;
  mcpUrl: string;
  close: () => Promise<void>;
  counts: { register: number; authorize: number; token: number; refresh: number };
  authorizeUrls: string[];
  paths: string[];
  authorizedHeaders: Array<Record<string, string | undefined>>;
  requireScope: string;
}

function startHarness(options?: {
  noDcr?: boolean;
  cimd?: boolean;
  rejectOnce?: boolean;
  metadataFromHeader?: boolean;
  pathIssuer?: boolean;
}): Promise<Harness> {
  const counts = { register: 0, authorize: 0, token: 0, refresh: 0 };
  const authorizeUrls: string[] = [];
  const paths: string[] = [];
  const authorizedHeaders: Array<Record<string, string | undefined>> = [];
  const clients = new Map<string, string>();
  const codes = new Map<string, { clientId: string; scope: string; resource: string }>();
  const tokens = new Map<string, { scope: string; refresh: string }>();
  let rejected = false;
  let tokenNumber = 0;
  const harness: Harness = {
    origin: '',
    mcpUrl: '',
    close: async () => undefined,
    counts,
    authorizeUrls,
    paths,
    authorizedHeaders,
    requireScope: '',
  };

  const server = createServer(async (request, response) => {
    const origin = harness.origin;
    const url = new URL(request.url ?? '/', origin);
    paths.push(url.pathname);
    if (request.method === 'GET' && url.pathname === '/mcp') {
      send(response, 405, 'Method Not Allowed');
      return;
    }
    if (request.method === 'DELETE') {
      send(response, 405, 'Method Not Allowed');
      return;
    }
    if (request.method === 'POST' && url.pathname === '/mcp') {
      await handleMcp(request, response);
      return;
    }
    if (request.method === 'GET' && (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/custom-prm')) {
      if (options?.metadataFromHeader && url.pathname === '/.well-known/oauth-protected-resource') {
        send(response, 500, 'wrong metadata');
        return;
      }
      sendJson(response, 200, {
        resource: harness.mcpUrl,
        authorization_servers: [options?.pathIssuer ? `${origin}/tenant` : origin],
        scopes_supported: ['mcp:read', 'mcp:write'],
      });
      return;
    }
    if (request.method === 'GET' && url.pathname.includes('well-known')) {
      const issuer = options?.pathIssuer ? `${origin}/tenant` : origin;
      const oidcPath = options?.pathIssuer ? '/tenant/.well-known/openid-configuration' : '/.well-known/openid-configuration';
      const oauthPath = options?.pathIssuer
        ? '/.well-known/oauth-authorization-server/tenant'
        : '/.well-known/oauth-authorization-server';
      if (url.pathname === oauthPath) {
        send(response, 404, 'missing');
        return;
      }
      if (url.pathname !== oidcPath && url.pathname !== oauthPath) {
        send(response, 404, 'missing');
        return;
      }
      sendJson(response, 200, metadata(issuer));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/register') {
      counts.register += 1;
      const id = `client-${counts.register}`;
      const secret = `secret-value-${counts.register}`;
      clients.set(id, secret);
      sendJson(response, 201, { client_id: id, client_secret: secret });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/authorize') {
      counts.authorize += 1;
      authorizeUrls.push(url.toString());
      const code = `code-${counts.authorize}`;
      codes.set(code, {
        clientId: url.searchParams.get('client_id') ?? '',
        scope: url.searchParams.get('scope') ?? '',
        resource: url.searchParams.get('resource') ?? '',
      });
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
      response.writeHead(302, { Location: redirect.toString() });
      response.end();
      return;
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      counts.token += 1;
      const body = new URLSearchParams(await readBody(request));
      const presented = presentedClient(request, body);
      if (options?.rejectOnce && !rejected) {
        rejected = true;
        sendJson(response, 401, { error: 'invalid_client' });
        return;
      }
      if (presented.secret && clients.has(presented.id) && clients.get(presented.id) !== presented.secret) {
        sendJson(response, 401, { error: 'invalid_client' });
        return;
      }
      if (body.get('grant_type') === 'refresh_token') {
        counts.refresh += 1;
        const current = [...tokens.values()].find((token) => token.refresh === body.get('refresh_token'));
        tokenNumber += 1;
        const access = `access-${tokenNumber}`;
        tokens.set(access, { scope: current?.scope ?? '', refresh: body.get('refresh_token') ?? '' });
        sendJson(response, 200, {
          access_token: access,
          refresh_token: body.get('refresh_token'),
          token_type: 'Bearer',
          expires_in: 3600,
          scope: current?.scope ?? '',
        });
        return;
      }
      const issued = codes.get(body.get('code') ?? '');
      if (!issued || body.get('code_verifier') == null) {
        sendJson(response, 400, { error: 'invalid_grant' });
        return;
      }
      tokenNumber += 1;
      const access = `access-${tokenNumber}`;
      const refresh = `refresh-${tokenNumber}`;
      tokens.set(access, { scope: issued.scope, refresh });
      sendJson(response, 200, {
        access_token: access,
        refresh_token: refresh,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: issued.scope,
      });
      return;
    }
    send(response, 404, 'missing');
  });

  function metadata(issuer: string) {
    return {
      issuer,
      authorization_endpoint: `${harness.origin}/authorize`,
      token_endpoint: `${harness.origin}/token`,
      ...(options?.noDcr ? {} : { registration_endpoint: `${harness.origin}/register` }),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      ...(options?.cimd ? { client_id_metadata_document_supported: true } : {}),
    };
  }

  async function handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = request.headers.authorization ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    const resourceMetadata = options?.metadataFromHeader
      ? `${harness.origin}/custom-prm`
      : `${harness.origin}/.well-known/oauth-protected-resource`;
    if (!token || !tokens.has(token)) {
      response.writeHead(401, {
        'WWW-Authenticate': `Bearer realm="mcp", resource_metadata="${resourceMetadata}", scope="mcp:read"`,
        'Content-Type': 'application/json',
      });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const granted = tokens.get(token);
    if (harness.requireScope && !granted?.scope.split(/\s+/).includes(harness.requireScope)) {
      response.writeHead(403, {
        'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${harness.requireScope}", resource_metadata="${resourceMetadata}"`,
      });
      response.end();
      return;
    }
    authorizedHeaders.push({ ...request.headers } as Record<string, string | undefined>);
    const raw = await readBody(request);
    const message = raw ? (JSON.parse(raw) as { id?: number; method?: string; params?: { protocolVersion?: string } }) : {};
    if (!message.method || message.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    if (message.method === 'initialize') {
      sendJson(response, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'docs', version: '1' },
        },
      });
      return;
    }
    if (message.method === 'tools/list') {
      sendJson(response, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            {
              name: 'ping',
              description: 'Ping',
              inputSchema: { type: 'object', properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      });
      return;
    }
    sendJson(response, 200, { jsonrpc: '2.0', id: message.id, result: {} });
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      harness.origin = `http://127.0.0.1:${port}`;
      harness.mcpUrl = `${harness.origin}/mcp`;
      harness.close = () =>
        new Promise((done, reject) => {
          server.close((error) => (error ? reject(error) : done()));
        });
      resolve(harness);
    });
  });
}

function presentedClient(request: IncomingMessage, body: URLSearchParams): { id: string; secret: string } {
  const header = request.headers.authorization ?? '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return { id: decoded.slice(0, separator), secret: decoded.slice(separator + 1) };
  }
  return { id: body.get('client_id') ?? '', secret: body.get('client_secret') ?? '' };
}

function send(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain' });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function boot(openExternal?: (url: string) => Promise<void>) {
  const rawBranding = JSON.parse(readFileSync('branding/default.json', 'utf8')) as Record<string, unknown>;
  const branding = parseBranding({ ...rawBranding, appName: 'Northstar', agentName: 'Northstar' }, null);
  const config = parseEnterpriseConfig(JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')));
  const db = Repository.open(':memory:');
  const secrets = new MemorySecretStore();
  const runtime = await Runtime.create({
    config,
    branding,
    db,
    secrets,
    appRoot: process.cwd(),
    attachmentsDir: mkdtempSync(join(tmpdir(), 'agent-ext-')),
    encryptionAvailable: true,
    openExternal,
  });
  return { runtime, db, secrets };
}
