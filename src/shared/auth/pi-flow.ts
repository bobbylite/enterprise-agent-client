import type { LoginDevice } from '../types';
import { readTokenResponse, type TokenSet } from './tokens';

const USERNAME_PASSWORD = 'application/vnd.pingidentity.usernamePassword.check+json';
const OTP_CHECK = 'application/vnd.pingidentity.otp.check+json';
const DEVICE_SELECT = 'application/vnd.pingidentity.device.select+json';

export const MFA_STATUSES = new Set([
  'OTP_REQUIRED',
  'ASSERTION_REQUIRED',
  'PUSH_CONFIRMATION_REQUIRED',
  'MFA_REQUIRED',
  'VERIFICATION_CODE_REQUIRED',
]);

export interface FlowSnapshot {
  id: string;
  status: string;
  resumeUrl?: string;
  links: Record<string, string>;
  authorizeResponse?: { code?: string; state?: string };
  devices: LoginDevice[];
  user?: { id: string; username: string };
  rawStatus: string;
}

export interface PiFlowClientOptions {
  authHost: string;
  environmentId: string;
  clientId: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class PiFlowClient {
  private cookies: string[] = [];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: PiFlowClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private base(): string {
    return `${this.options.authHost.replace(/\/$/, '')}/${this.options.environmentId}`;
  }

  async startAuthorize(input: {
    redirectUri: string;
    scopes: string[];
    challenge: string;
    state: string;
    acrValues?: string;
    loginHint?: string;
  }): Promise<FlowSnapshot> {
    const url = new URL(`${this.base()}/as/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', input.scopes.join(' '));
    url.searchParams.set('code_challenge', input.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('response_mode', 'pi.flow');
    url.searchParams.set('state', input.state);
    if (input.acrValues) url.searchParams.set('acr_values', input.acrValues);
    if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);
    return this.readFlow(await this.request(url, { method: 'GET' }));
  }

  async submitUsernamePassword(flow: FlowSnapshot, username: string, password: string): Promise<FlowSnapshot> {
    return this.postAction(flow, 'usernamePassword.check', USERNAME_PASSWORD, { username, password });
  }

  async submitOtp(flow: FlowSnapshot, otp: string): Promise<FlowSnapshot> {
    return this.postAction(flow, 'otp.check', OTP_CHECK, { otp });
  }

  async selectDevice(flow: FlowSnapshot, deviceId: string): Promise<FlowSnapshot> {
    return this.postAction(flow, 'device.select', DEVICE_SELECT, { device: { id: deviceId } });
  }

  async authorizationCode(flow: FlowSnapshot): Promise<{ code: string; state?: string }> {
    if (flow.authorizeResponse?.code) {
      return { code: flow.authorizeResponse.code, state: flow.authorizeResponse.state };
    }
    if (!flow.resumeUrl) {
      throw new Error('The sign-in flow completed without an authorization code.');
    }
    const response = await this.request(flow.resumeUrl, { method: 'GET', redirect: 'manual' });
    const location = response.headers.get('location');
    if (location) {
      const redirect = new URL(location, flow.resumeUrl);
      const code = redirect.searchParams.get('code');
      if (code) return { code, state: redirect.searchParams.get('state') ?? undefined };
      const error = redirect.searchParams.get('error_description') || redirect.searchParams.get('error');
      if (error) throw new Error(error);
    }
    if (response.text) {
      const body = JSON.parse(response.text) as { authorizeResponse?: { code?: string; state?: string } };
      if (body.authorizeResponse?.code) {
        return { code: body.authorizeResponse.code, state: body.authorizeResponse.state };
      }
    }
    throw new Error('The resume response did not include an authorization code.');
  }

  async exchangeCode(input: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: this.options.clientId,
      code_verifier: input.verifier,
    });
    return this.tokenRequest(body);
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.options.clientId,
    });
    return this.tokenRequest(body);
  }

  private async tokenRequest(body: URLSearchParams): Promise<TokenSet> {
    const response = await this.request(`${this.base()}/as/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const parsed = response.text ? JSON.parse(response.text) : {};
    if (response.status >= 400) {
      throw new Error(errorMessage(parsed, response.status));
    }
    return readTokenResponse(parsed, this.now());
  }

  private async postAction(
    flow: FlowSnapshot,
    link: string,
    contentType: string,
    payload: unknown,
  ): Promise<FlowSnapshot> {
    const href = flow.links[link];
    if (!href) throw new Error(`This sign-in step does not accept ${link}.`);
    return this.readFlow(
      await this.request(href, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: JSON.stringify(payload),
      }),
    );
  }

  private readFlow(response: HttpText): FlowSnapshot {
    const body = response.text ? (JSON.parse(response.text) as Record<string, unknown>) : {};
    if (response.status >= 400 || (typeof body.code === 'string' && typeof body.message === 'string' && !body.status)) {
      throw new Error(errorMessage(body, response.status));
    }
    const links: Record<string, string> = {};
    const linkBag = (body._links ?? {}) as Record<string, { href?: string }>;
    for (const [key, value] of Object.entries(linkBag)) {
      if (value && typeof value.href === 'string') links[key] = value.href;
    }
    const embedded = (body._embedded ?? {}) as {
      user?: { id?: string; username?: string };
      devices?: { id?: string; type?: string; phone?: string; email?: string }[];
    };
    const authorize = body.authorizeResponse as { code?: string; state?: string } | undefined;
    const devices = (embedded.devices ?? [])
      .filter((device) => typeof device.id === 'string')
      .map((device) => ({
        id: device.id as string,
        type: device.type ?? 'DEVICE',
        label: [device.type, device.phone, device.email].filter(Boolean).join(' · ') || 'Device',
      }));
    return {
      id: String(body.id ?? ''),
      status: String(body.status ?? ''),
      rawStatus: String(body.status ?? ''),
      resumeUrl: typeof body.resumeUrl === 'string' ? body.resumeUrl : undefined,
      links,
      authorizeResponse: authorize,
      devices,
      user:
        embedded.user?.id
          ? { id: embedded.user.id, username: embedded.user.username ?? embedded.user.id }
          : undefined,
    };
  }

  private async request(url: string | URL, init: RequestInit): Promise<HttpText> {
    const headers = new Headers(init.headers);
    if (this.cookies.length > 0) headers.set('Cookie', this.cookies.join('; '));
    const response = await this.fetchImpl(url.toString(), {
      ...init,
      headers,
      redirect: init.redirect ?? 'follow',
    });
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const cookie of setCookies) {
      const pair = cookie.split(';')[0] ?? '';
      const name = pair.split('=')[0];
      if (!name) continue;
      this.cookies = this.cookies.filter((item) => !item.startsWith(`${name}=`));
      this.cookies.push(pair);
    }
    return {
      status: response.status,
      headers: response.headers,
      text: await response.text(),
    };
  }
}

interface HttpText {
  status: number;
  headers: Headers;
  text: string;
}

function errorMessage(body: unknown, status: number): string {
  const record = (body ?? {}) as { message?: string; details?: { message?: string }[]; error_description?: string; error?: string };
  const details = Array.isArray(record.details)
    ? record.details.map((item) => item.message).filter(Boolean).join(' ')
    : '';
  return details || record.message || record.error_description || record.error || `Authorization server returned ${status}.`;
}

export function buildAuthorizeUrl(input: {
  authHost: string;
  environmentId: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  challenge: string;
  state: string;
  responseMode: 'query' | 'pi.flow';
}): string {
  const url = new URL(`${input.authHost.replace(/\/$/, '')}/${input.environmentId}/as/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', input.scopes.join(' '));
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('response_mode', input.responseMode);
  url.searchParams.set('state', input.state);
  return url.toString();
}
