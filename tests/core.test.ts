import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPkce } from '../src/shared/auth/pkce';
import { PiFlowClient, signInStepMessage } from '../src/shared/auth/pi-flow';
import { waitForLoopbackCode } from '../src/shared/auth/loopback';
import { classifyAccessToken } from '../src/shared/auth/tokens';
import { parseBranding } from '../src/shared/branding';
import { parseEnterpriseConfig, tokenInspectorEnabled } from '../src/shared/config';
import { composeInstructions } from '../src/shared/instructions/compose';
import { choiceFromUser, previewApproval } from '../src/shared/mcp/approvals';
import { renderRiskContext } from '../src/shared/protect/context';
import { buildRiskEvent, resolvePublicIp } from '../src/shared/protect/evaluate';
import { mockRiskPayload } from '../src/shared/protect/mock';
import { decideRisk, summarizeRisk, unscoredRisk } from '../src/shared/protect/policy';
import { extractRiskReasons } from '../src/shared/protect/reasons';
import {
  createOpenAiProvider,
  isReasoningModel,
  openAiChatBody,
  REASONING_MAX_COMPLETION_TOKENS,
  unsupportedParameters,
} from '../src/shared/providers/openai';
import { parseAnthropicData, parseOpenAiData } from '../src/shared/providers/sse';
import { mockResult } from '../src/shared/providers/mock';
import { assertValidCron, cronMatches } from '../src/shared/schedule/cron';
import { AudienceTokenCache, exchangeSubjectToken } from '../src/shared/tokens/exchange';
import { MemorySecretStore } from '../src/shared/secrets';
import { parseEnv, redactSecrets } from '../src/shared/env';
import { encodeJsonSegment } from '../src/shared/ids';
import { inspectJwt } from '../src/shared/tokens/inspect';

describe('branding', () => {
  it('requires an app name and does not invent one', () => {
    expect(() => parseBranding({ agentName: 'Ada' }, null)).toThrow(/appName/);
  });

  it('loads the sample theme from the branding file', () => {
    const raw = JSON.parse(readFileSync('branding/default.json', 'utf8')) as { appName: string; agentName: string };
    const branding = parseBranding(raw, null);
    expect(branding.appName).toBe(raw.appName);
    expect(branding.agentName).toBe(raw.agentName);
    expect(branding.appName).toBe(branding.agentName);
  });

  it('does not hardcode the sample agent name in source', () => {
    const raw = JSON.parse(readFileSync('branding/default.json', 'utf8')) as { agentName: string };
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|js|mjs|css)$/.test(path)) {
          const text = readFileSync(path, 'utf8');
          if (text.includes(raw.agentName)) hits.push(path);
        }
      }
    };
    walk('src');
    expect(hits).toEqual([]);
  });
});

describe('pkce and session freshness', () => {
  it('creates an S256 challenge', async () => {
    const pkce = await createPkce();
    expect(pkce.verifier).not.toBe(pkce.challenge);
    expect(pkce.challenge).not.toContain('=');
    expect(pkce.state).not.toBe(pkce.verifier);
  });

  it('refreshes only when a refresh token exists', () => {
    const now = 1_000_000;
    expect(classifyAccessToken({ expiresAt: now + 120_000 }, now)).toBe('valid');
    expect(classifyAccessToken({ expiresAt: now + 10_000, refreshToken: 'r' }, now)).toBe('refresh');
    expect(classifyAccessToken({ expiresAt: now + 10_000 }, now)).toBe('reauth');
  });
});

describe('pi.flow', () => {
  it('submits credentials, keeps cookies, and exchanges the code', async () => {
    const seen: { url: string; cookie?: string; body?: string; contentType?: string }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(url),
        cookie: headers.get('cookie') ?? undefined,
        body:
          typeof init?.body === 'string'
            ? init.body
            : init?.body instanceof URLSearchParams
              ? init.body.toString()
              : undefined,
        contentType: headers.get('content-type') ?? undefined,
      });
      if (String(url).includes('/as/authorize')) {
        return json(200, {
          id: 'flow-1',
          status: 'USERNAME_PASSWORD_REQUIRED',
          _links: { 'usernamePassword.check': { href: 'https://auth.example/flows/flow-1' } },
          resumeUrl: 'https://auth.example/as/resume?flowId=flow-1',
        }, ['ST=abc; Path=/; HttpOnly']);
      }
      if (String(url).includes('/flows/flow-1')) {
        return json(200, {
          id: 'flow-1',
          status: 'COMPLETED',
          authorizeResponse: { code: 'auth-code', state: 'state-1' },
          _embedded: { user: { id: 'user-1', username: 'ada' } },
        });
      }
      return json(200, { access_token: 'user-token', expires_in: 60, token_type: 'Bearer', refresh_token: 'refresh-1' });
    };
    const client = new PiFlowClient({
      authHost: 'https://auth.example',
      environmentId: 'env-1',
      clientId: 'client-1',
      fetchImpl,
      now: () => 0,
    });
    const flow = await client.startAuthorize({
      redirectUri: 'http://127.0.0.1:53147/callback',
      scopes: ['openid'],
      challenge: 'challenge',
      state: 'state-1',
    });
    const done = await client.submitUsernamePassword(flow, 'ada', 'secret');
    expect(seen[1]?.cookie).toContain('ST=abc');
    expect(seen[1]?.contentType).toContain('usernamePassword.check');
    const code = await client.authorizationCode(done);
    const tokens = await client.exchangeCode({
      code: code.code,
      verifier: 'verifier',
      redirectUri: 'http://127.0.0.1:53147/callback',
    });
    expect(tokens.accessToken).toBe('user-token');
    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.expiresAt).toBe(60_000);
    expect(seen[2]?.body).toContain('code_verifier=verifier');
  });

  it('posts user.lookup before usernamePassword.check on an identifier-first policy', async () => {
    const seen: { url: string; cookie?: string; body?: string; contentType?: string }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(url),
        cookie: headers.get('cookie') ?? undefined,
        body: typeof init?.body === 'string' ? init.body : undefined,
        contentType: headers.get('content-type') ?? undefined,
      });
      const type = headers.get('content-type') ?? '';
      if (String(url).includes('/as/authorize')) {
        return json(200, {
          id: 'flow-id',
          status: 'SIGN_ON_REQUIRED',
          _links: {
            self: { href: 'https://auth.example/env-1/flows/flow-id' },
            'user.lookup': { href: 'https://auth.example/env-1/flows/flow-id' },
          },
        });
      }
      if (type.includes('user.lookup')) {
        return json(
          200,
          {
            id: 'flow-id',
            status: 'PASSWORD_REQUIRED',
            _links: {
              'usernamePassword.check': { href: 'https://auth.example/env-1/flows/flow-id' },
            },
          },
          ['ST=session; Path=/; HttpOnly'],
        );
      }
      return json(200, {
        id: 'flow-id',
        status: 'COMPLETED',
        authorizeResponse: { code: 'auth-code' },
        _embedded: { user: { id: 'user-1', username: 'ada' } },
      });
    };
    const client = new PiFlowClient({
      authHost: 'https://auth.example',
      environmentId: 'env-1',
      clientId: 'client-1',
      fetchImpl,
    });
    const flow = await client.startAuthorize({
      redirectUri: 'http://127.0.0.1:53147/callback',
      scopes: ['openid'],
      challenge: 'challenge',
      state: 'state-1',
    });
    const done = await client.submitCredentials(flow, 'ada', 'secret');
    expect(done.status).toBe('COMPLETED');
    expect(seen[1]?.url).toBe('https://auth.example/env-1/flows/flow-id');
    expect(seen[1]?.contentType).toBe('application/vnd.pingidentity.user.lookup+json');
    expect(JSON.parse(seen[1]?.body ?? '{}')).toEqual({ username: 'ada' });
    expect(seen[2]?.url).toBe('https://auth.example/env-1/flows/flow-id');
    expect(seen[2]?.contentType).toBe('application/vnd.pingidentity.usernamePassword.check+json');
    expect(JSON.parse(seen[2]?.body ?? '{}')).toEqual({ username: 'ada', password: 'secret' });
    expect(seen[2]?.cookie).toContain('ST=session');
    expect(seen).toHaveLength(3);
  });

  it('does not post the password when lookup moves to a one-time code', async () => {
    const bodies: { body: string; contentType: string }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      if (typeof init?.body === 'string') {
        bodies.push({ body: init.body, contentType: headers.get('content-type') ?? '' });
      }
      if (String(url).includes('/as/authorize')) {
        return json(200, {
          id: 'flow-otp',
          status: 'IDENTIFIER_REQUIRED',
          _links: { 'username.check': 'https://auth.example/env-1/flows/flow-otp' },
        });
      }
      return json(200, {
        id: 'flow-otp',
        status: 'OTP_REQUIRED',
        _links: { 'otp.check': { href: 'https://auth.example/env-1/flows/flow-otp' } },
      });
    };
    const client = new PiFlowClient({
      authHost: 'https://auth.example',
      environmentId: 'env-1',
      clientId: 'client-1',
      fetchImpl,
    });
    const flow = await client.startAuthorize({
      redirectUri: 'http://127.0.0.1:53147/callback',
      scopes: ['openid'],
      challenge: 'challenge',
      state: 'state-1',
    });
    const next = await client.submitCredentials(flow, 'ada', 'secret');
    expect(next.status).toBe('OTP_REQUIRED');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.contentType).toBe('application/vnd.pingidentity.username.check+json');
    expect(JSON.parse(bodies[0]?.body ?? '{}')).toEqual({ username: 'ada' });
  });

  it('posts usernamePassword.check to the canonical flow url when the link href is missing', async () => {
    let posted: { url: string; contentType: string } | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      if (String(url).includes('/as/authorize')) {
        return json(200, { id: 'flow-9', status: 'USERNAME_PASSWORD_REQUIRED' });
      }
      posted = { url: String(url), contentType: headers.get('content-type') ?? '' };
      return json(200, { id: 'flow-9', status: 'COMPLETED', authorizeResponse: { code: 'auth-code' } });
    };
    const client = new PiFlowClient({
      authHost: 'https://auth.example/',
      environmentId: 'env-1',
      clientId: 'client-1',
      fetchImpl,
    });
    const flow = await client.startAuthorize({
      redirectUri: 'http://127.0.0.1:53147/callback',
      scopes: ['openid'],
      challenge: 'challenge',
      state: 'state-1',
    });
    await client.submitCredentials(flow, 'ada', 'secret');
    expect(posted).toEqual({
      url: 'https://auth.example/env-1/flows/flow-9',
      contentType: 'application/vnd.pingidentity.usernamePassword.check+json',
    });
  });

  it('names the flow status when the step is not a credential check', async () => {
    const flow = {
      id: 'flow-ext',
      status: 'EXTERNAL_AUTHENTICATION_REQUIRED',
      rawStatus: 'EXTERNAL_AUTHENTICATION_REQUIRED',
      links: { authenticate: 'https://auth.example/idp' },
      devices: [],
    };
    await expect(
      new PiFlowClient({
        authHost: 'https://auth.example',
        environmentId: 'env-1',
        clientId: 'client-1',
        fetchImpl: async () => json(500, {}),
      }).submitCredentials(flow, 'ada', 'secret'),
    ).rejects.toThrow(/EXTERNAL_AUTHENTICATION_REQUIRED/);
    expect(signInStepMessage(flow)).toMatch(/external identity provider/);
    expect(signInStepMessage({ ...flow, status: 'ASSERTION_REQUIRED', rawStatus: 'ASSERTION_REQUIRED' })).toMatch(/security key/);
  });
});

describe('loopback', () => {
  it('accepts a matching state and rejects a mismatch', async () => {
    const pending = waitForLoopbackCode({
      redirectUri: 'http://127.0.0.1:53147/callback',
      expectedState: 'good-state',
      timeoutMs: 2000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const response = await fetch('http://127.0.0.1:53147/callback?code=abc&state=good-state');
    expect(response.status).toBe(200);
    await expect(pending).resolves.toEqual({ code: 'abc', state: 'good-state' });

    const rejected = waitForLoopbackCode({
      redirectUri: 'http://127.0.0.1:53148/callback',
      expectedState: 'good-state',
      timeoutMs: 2000,
    });
    const mismatch = expect(rejected).rejects.toThrow(/state/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fetch('http://127.0.0.1:53148/callback?code=abc&state=bad-state');
    await mismatch;
  });
});

describe('token exchange', () => {
  it('sends an RFC 8693 request and caches until expiry', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      const body = String(init?.body);
      expect(body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange');
      expect(body).toContain('audience=https%3A%2F%2Fmcp.example');
      expect(new Headers(init?.headers).get('authorization')).toContain('Basic ');
      return json(200, { access_token: 'aud-token', expires_in: 120, token_type: 'Bearer' });
    };
    const now = { value: 1_000 };
    const cache = new AudienceTokenCache(new MemorySecretStore(), 60_000, () => now.value);
    const first = await exchangeSubjectToken({
      tokenEndpoint: 'https://auth.example/env/as/token',
      subjectToken: 'user-token',
      audience: 'https://mcp.example',
      scope: 'mcp:tools',
      clientId: 'worker',
      clientSecret: 'secret',
      fetchImpl,
      now: () => now.value,
    });
    await cache.put('https://mcp.example', first);
    expect(await cache.get('https://mcp.example')).toMatchObject({ accessToken: 'aud-token' });
    now.value = first.expiresAt;
    expect(await cache.get('https://mcp.example')).toBeNull();
    expect(calls).toBe(1);
  });

  it('adds actor_token only when an actor token is supplied', async () => {
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body));
      const authorization = new Headers(init?.headers).get('authorization') ?? '';
      expect(Buffer.from(authorization.replace(/^Basic /, ''), 'base64').toString('utf8')).toBe('agent-id:agent-secret');
      return json(200, { access_token: 'aud-token', expires_in: 120, token_type: 'Bearer' });
    };
    const request = {
      tokenEndpoint: 'https://auth.example/env/as/token',
      subjectToken: 'user-token',
      audience: 'https://mcp.example',
      clientId: 'agent-id',
      clientSecret: 'agent-secret',
      fetchImpl,
    };
    await exchangeSubjectToken(request);
    await exchangeSubjectToken({ ...request, actorToken: 'agent-actor-token' });
    const plain = new URLSearchParams(bodies[0]);
    const delegated = new URLSearchParams(bodies[1]);
    expect(plain.get('actor_token')).toBeNull();
    expect(plain.get('actor_token_type')).toBeNull();
    expect(delegated.get('actor_token')).toBe('agent-actor-token');
    expect(delegated.get('actor_token_type')).toBe('urn:ietf:params:oauth:token-type:access_token');
  });
});

describe('protect policy', () => {
  const policy = parseEnterpriseConfig(JSON.parse(readFileSync('config/enterprise.example.json', 'utf8'))).protect.policy;

  it('extracts new device, location, travel, and bot reasons', () => {
    expect(extractRiskReasons(mockRiskPayload('new_device').details).map((reason) => reason.code)).toContain('NEW_DEVICE');
    expect(extractRiskReasons(mockRiskPayload('anomalous_location').details).map((reason) => reason.code)).toContain('ANOMALOUS_LOCATION');
    expect(extractRiskReasons(mockRiskPayload('impossible_travel').details).map((reason) => reason.code)).toContain('IMPOSSIBLE_TRAVEL');
    expect(extractRiskReasons(mockRiskPayload('bot').details).map((reason) => reason.code)).toContain('BOT');
    expect(extractRiskReasons(mockRiskPayload('low').details)).toEqual([]);
  });

  it('lets the most restrictive matching action win', () => {
    const travel = mockRiskPayload('impossible_travel');
    const reasons = extractRiskReasons(travel.details);
    expect(decideRisk(policy, travel.level, reasons)).toBe('block');
    const location = mockRiskPayload('anomalous_location');
    expect(decideRisk(policy, location.level, extractRiskReasons(location.details))).toBe('restrict_tools');
    expect(decideRisk(policy, 'LOW', [])).toBe('allow');
  });

  it('writes a risk context the agent can quote', () => {
    const payload = mockRiskPayload('new_device');
    const reasons = extractRiskReasons(payload.details);
    const action = decideRisk(policy, payload.level, reasons);
    const text = renderRiskContext(
      {
        level: payload.level,
        action,
        reasons,
        summary: summarizeRisk(payload.level, action, reasons),
        signalsCollected: true,
        evaluatedAt: 0,
      },
      'Northstar',
    );
    expect(text).toContain('Risk level: MEDIUM');
    expect(text).toContain('New device');
    expect(text).toContain('Policy action: step_up_mfa');
    expect(text).toContain('Northstar');
  });

  it('defaults unknown risk to restricted tools and tells the agent', () => {
    const raw = JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')) as {
      protect: { resolvePublicIp: boolean; policy: { levels: { UNKNOWN?: string } } };
    };
    expect(raw.protect.resolvePublicIp).toBe(true);
    delete raw.protect.policy.levels.UNKNOWN;
    const parsed = parseEnterpriseConfig(raw);
    expect(parsed.protect.policy.levels.UNKNOWN).toBe('restrict_tools');
    const risk = unscoredRisk(parsed.protect.policy, 0, false);
    expect(risk.level).toBe('UNKNOWN');
    expect(risk.action).toBe('restrict_tools');
    const text = renderRiskContext(risk, 'Northstar');
    expect(text).toContain('Protect did not score this sign-in');
    expect(text).toContain('Client IP unavailable');
    expect(text).toContain('Policy action: restrict_tools');
  });
});

describe('public IP lookup', () => {
  it('uses the fallback address when the first lookup fails', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      seen.push(String(url));
      expect(init?.signal).toBeTruthy();
      if (String(url).includes('ipify')) throw new Error('timed out');
      return new Response('203.0.113.8\n', { status: 200 });
    };
    await expect(resolvePublicIp(fetchImpl, 50)).resolves.toBe('203.0.113.8');
    expect(seen[0]).toContain('api.ipify.org');
    expect(seen[1]).toContain('checkip.amazonaws.com');
  });

  it('omits ip from the risk event when lookup cannot produce one', async () => {
    const fetchImpl: typeof fetch = async () => new Response('nope', { status: 500 });
    await expect(resolvePublicIp(fetchImpl, 50)).rejects.toThrow(/IP lookup failed/);
    const event = buildRiskEvent({
      userId: 'user-1',
      username: 'ada',
      userType: 'EXTERNAL',
      userAgent: 'test',
      targetId: 'desktop',
      targetName: 'Desk',
    });
    expect(event.ip).toBeUndefined();
  });
});

describe('instructions and approvals', () => {
  it('orders enterprise policy above persona and user text', () => {
    const prompt = composeInstructions({
      branding: { appName: 'Northstar', agentName: 'Northstar' },
      enterprise: fields('Enterprise rule'),
      persona: fields('Persona rule'),
      user: fields('User rule'),
      room: 'Room rule',
      risk: 'Risk level: LOW.',
    });
    expect(prompt.indexOf('Enterprise rule')).toBeLessThan(prompt.indexOf('Persona rule'));
    expect(prompt.indexOf('Persona rule')).toBeLessThan(prompt.indexOf('User rule'));
    expect(prompt.indexOf('User rule')).toBeLessThan(prompt.indexOf('Room rule'));
    expect(prompt).toContain('You are Northstar');
  });

  it('forces a prompt when tools are restricted and blocks writes in read-only mode', () => {
    expect(previewApproval({ riskAction: 'read_only', readOnlyHint: false })).toMatchObject({ type: 'deny', automatic: true });
    expect(previewApproval({ riskAction: 'read_only', readOnlyHint: true })).toMatchObject({ type: 'prompt' });
    expect(previewApproval({ riskAction: 'restrict_tools', readOnlyHint: true, remembered: 'always' })).toMatchObject({
      type: 'prompt',
      allowAlways: false,
    });
    expect(previewApproval({ riskAction: 'allow', readOnlyHint: false, remembered: 'always' })).toMatchObject({
      type: 'allow',
      persistence: 'always',
    });
    expect(choiceFromUser('always', false)).toMatchObject({ type: 'allow', persistence: 'once' });
    expect(previewApproval({ riskAction: 'block', readOnlyHint: true })).toMatchObject({ type: 'deny' });
  });
});

describe('cron and providers', () => {
  it('matches weekdays and steps', () => {
    expect(cronMatches('0 9 * * 1-5', new Date(2026, 9, 12, 9, 0, 30))).toBe(true);
    expect(cronMatches('0 9 * * 1-5', new Date(2026, 9, 11, 9, 0))).toBe(false);
    expect(cronMatches('*/15 * * * *', new Date(2026, 0, 1, 3, 45))).toBe(true);
    expect(cronMatches('*/15 * * * *', new Date(2026, 0, 1, 3, 10))).toBe(false);
    expect(() => assertValidCron('* * *')).toThrow(/5 fields/);
  });

  it('parses provider streams and lets the mock provider call echo', () => {
    expect(parseOpenAiData('[DONE]')).toBe('done');
    expect(parseOpenAiData(JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] }))).toMatchObject({ text: 'Hi' });
    expect(
      parseAnthropicData(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Yo' } })),
    ).toMatchObject({ text: 'Yo' });
    const echoed = mockResult({
      model: 'mock-1',
      system: 'Risk level: LOW. Policy action: allow.',
      temperature: 0,
      tools: [{ name: 'echo__echo', description: 'Echo', inputSchema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'echo hello' }],
    });
    expect(echoed.toolCalls[0]?.arguments).toContain('hello');
    const follow = mockResult({
      model: 'mock-1',
      system: 'Risk level: HIGH. Policy action: block.',
      temperature: 0,
      tools: [],
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'tool', content: 'hello', toolCallId: '1' },
      ],
    });
    expect(follow.content).toContain('HIGH');
  });

  it('omits temperature for gpt-5 and retries once when the API rejects it', async () => {
    const request = {
      model: 'gpt-5',
      system: 'Be brief.',
      messages: [{ role: 'user' as const, content: 'Hello' }],
      tools: [],
      temperature: 0.2,
      reasoningEffort: 'medium' as const,
      apiKey: 'test-key',
    };
    const body = openAiChatBody(request);
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.max_completion_tokens).toBe(REASONING_MAX_COMPLETION_TOKENS);
    expect(body.reasoning_effort).toBe('medium');
    expect(isReasoningModel('openai/o3-mini')).toBe(true);
    expect(isReasoningModel('gpt-4o-mini')).toBe(false);
    expect(openAiChatBody({ ...request, model: 'gpt-4o', reasoningEffort: undefined }).temperature).toBe(0.2);
    expect(openAiChatBody({ ...request, model: 'gpt-4o', temperature: undefined, reasoningEffort: undefined }).temperature).toBeUndefined();
    expect(
      unsupportedParameters("Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported."),
    ).toEqual(['temperature']);

    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(sent);
      if (sent.temperature !== undefined) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.",
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const result = await createOpenAiProvider(fetchImpl).stream(
      { ...request, model: 'gpt-4.1', reasoningEffort: undefined },
      () => undefined,
    );
    expect(result.content).toBe('Hello');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.temperature).toBe(0.2);
    expect(bodies[1]?.temperature).toBeUndefined();

    let calls = 0;
    const failing: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'temperature'." } }), { status: 400 });
    };
    await expect(
      createOpenAiProvider(failing).stream({ ...request, model: 'gpt-4.1', reasoningEffort: undefined }, () => undefined),
    ).rejects.toThrow(/temperature/);
    expect(calls).toBe(2);

    const raw = JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')) as { provider: { temperature?: number } };
    expect(raw.provider.temperature).toBeUndefined();
    const configured = parseEnterpriseConfig({
      ...JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')),
      provider: {
        default: 'openai',
        openaiBaseUrl: 'https://api.openai.com/v1',
        openaiModel: 'gpt-5',
        anthropicBaseUrl: 'https://api.anthropic.com',
        anthropicModel: 'claude-sonnet-4-5',
        genericBaseUrl: '',
        genericModel: 'default',
        reasoningEffort: 'medium',
      },
    });
    expect(configured.provider.openaiModel).toBe('gpt-5');
    expect(configured.provider.reasoningEffort).toBe('medium');
    expect(configured.provider.temperature).toBeUndefined();
  });
});

describe('config safety', () => {
  it('rejects secrets embedded in enterprise config', () => {
    const raw = JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')) as Record<string, unknown>;
    expect(() => parseEnterpriseConfig({ ...raw, workerClientSecret: 'nope' })).toThrow(/keychain/);
  });

  it('parses env files without dropping quoted values', () => {
    expect(parseEnv('# comment\nOPENAI_API_KEY="abc 123"\n\nEMPTY=')).toEqual({
      OPENAI_API_KEY: 'abc 123',
      EMPTY: '',
    });
    expect(redactSecrets('Authorization: Bearer abc.def')).toContain('[redacted]');
  });

  it('shows token claims in the inspector and keeps the raw jwt out of that view', () => {
    const header = encodeJsonSegment({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
    const payload = encodeJsonSegment({
      aud: 'https://mcp.example',
      scope: 'mcp:tools',
      sub: 'user-1',
      act: { sub: 'worker' },
      may_act: { sub: 'agent' },
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const token = `${header}.${payload}.signaturevalue`;
    const inspected = inspectJwt(token, 1_700_000_000_000);
    expect(inspected.header).toMatchObject({ alg: 'RS256', kid: 'k1' });
    expect(inspected).toMatchObject({
      aud: 'https://mcp.example',
      scope: 'mcp:tools',
      sub: 'user-1',
      act: { sub: 'worker' },
      mayAct: { sub: 'agent' },
      exp: 1_700_003_600,
      iat: 1_700_000_000,
      expiresInMs: 3_600_000,
    });
    expect(JSON.stringify(inspected)).not.toContain(token);
    expect(redactSecrets(`leaked ${token}`)).toBe('leaked [redacted-jwt]');

    const config = parseEnterpriseConfig(JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')));
    expect(config.tokenExchange.inspectTokens).toBe(true);
    expect(config.tokenExchange.delegation).toBe(false);
    const omitted = structuredClone(config);
    delete omitted.tokenExchange.inspectTokens;
    expect(tokenInspectorEnabled(omitted, false)).toBe(true);
    omitted.tenant.mode = 'pingone';
    expect(tokenInspectorEnabled(omitted, false)).toBe(false);
    expect(tokenInspectorEnabled(omitted, true)).toBe(true);
    omitted.tokenExchange.inspectTokens = false;
    expect(tokenInspectorEnabled(omitted, true)).toBe(false);
  });
});

function fields(text: string) {
  return {
    persona: text,
    communicationStyle: '',
    autonomy: '',
    safety: '',
    untrustedContent: '',
  };
}

function json(status: number, body: unknown, cookies: string[] = []): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'set-cookie': cookies.join(', ') },
  });
}
