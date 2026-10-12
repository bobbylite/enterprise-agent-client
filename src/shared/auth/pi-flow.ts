import type { LoginDevice } from '../types';
import { readTokenResponse, type TokenSet } from './tokens';

const USERNAME_PASSWORD = 'application/vnd.pingidentity.usernamePassword.check+json';
const USER_LOOKUP = 'application/vnd.pingidentity.user.lookup+json';
const USERNAME_CHECK = 'application/vnd.pingidentity.username.check+json';
const OTP_CHECK = 'application/vnd.pingidentity.otp.check+json';
const DEVICE_SELECT = 'application/vnd.pingidentity.device.select+json';

const IDENTIFIER_STATUSES = new Set(['SIGN_ON_REQUIRED', 'IDENTIFIER_REQUIRED', 'USERNAME_REQUIRED']);
const PASSWORD_STATUSES = new Set(['USERNAME_PASSWORD_REQUIRED', 'PASSWORD_REQUIRED']);

export const MFA_STATUSES = new Set([
  'OTP_REQUIRED',
  'ASSERTION_REQUIRED',
  'PUSH_CONFIRMATION_REQUIRED',
  'PUSH_CONFIRMATION_TIMED_OUT',
  'MFA_REQUIRED',
  'VERIFICATION_CODE_REQUIRED',
]);

export function acceptsCredentialSubmit(flow: FlowSnapshot): boolean {
  return passwordStep(flow) || identifierStep(flow) !== null;
}

function passwordStep(flow: FlowSnapshot): boolean {
  return Boolean(flow.links['usernamePassword.check']) || (PASSWORD_STATUSES.has(flow.status) && Boolean(flow.id || flow.links.self));
}

function identifierStep(flow: FlowSnapshot): { link: 'user.lookup' | 'username.check'; mediaType: string } | null {
  if (flow.links['user.lookup']) return { link: 'user.lookup', mediaType: USER_LOOKUP };
  if (flow.links['username.check']) return { link: 'username.check', mediaType: USERNAME_CHECK };
  if (IDENTIFIER_STATUSES.has(flow.status) && (flow.id || flow.links.self)) {
    return { link: 'user.lookup', mediaType: USER_LOOKUP };
  }
  return null;
}

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
    return this.postPassword(flow, username, password);
  }

  /**
   * Posts the action the current status actually offers.
   * Identifier-first policies return SIGN_ON_REQUIRED (or IDENTIFIER_REQUIRED)
   * with user.lookup, then PASSWORD_REQUIRED with usernamePassword.check.
   * The password is posted only after that second status appears.
   */
  async submitCredentials(flow: FlowSnapshot, username: string, password: string): Promise<FlowSnapshot> {
    if (passwordStep(flow)) return this.postPassword(flow, username, password);
    const identifier = identifierStep(flow);
    if (!identifier) throw new Error(rejectedStep(flow, 'usernamePassword.check'));
    const identified = await this.postAction(
      flow,
      identifier.link,
      identifier.mediaType,
      { username },
      !flow.links[identifier.link],
    );
    if (!passwordStep(identified)) return identified;
    return this.postPassword(identified, username, password);
  }

  async submitOtp(flow: FlowSnapshot, otp: string): Promise<FlowSnapshot> {
    const implied = flow.status === 'OTP_REQUIRED' || flow.status === 'MFA_REQUIRED';
    return this.postAction(flow, 'otp.check', OTP_CHECK, { otp }, !flow.links['otp.check'] && implied);
  }

  async selectDevice(flow: FlowSnapshot, deviceId: string): Promise<FlowSnapshot> {
    return this.postAction(
      flow,
      'device.select',
      DEVICE_SELECT,
      { device: { id: deviceId } },
      !flow.links['device.select'] && flow.status === 'DEVICE_SELECTION_REQUIRED',
    );
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

  private postPassword(flow: FlowSnapshot, username: string, password: string): Promise<FlowSnapshot> {
    if (!passwordStep(flow)) throw new Error(rejectedStep(flow, 'usernamePassword.check'));
    return this.postAction(
      flow,
      'usernamePassword.check',
      USERNAME_PASSWORD,
      { username, password },
      !flow.links['usernamePassword.check'],
    );
  }

  private async postAction(
    flow: FlowSnapshot,
    link: string,
    contentType: string,
    payload: unknown,
    allowCanonical = false,
  ): Promise<FlowSnapshot> {
    const raw = flow.links[link];
    const href = raw ? this.absolute(raw) : allowCanonical ? this.canonical(flow) : '';
    if (!href) throw new Error(rejectedStep(flow, link));
    return this.readFlow(
      await this.request(href, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: JSON.stringify(payload),
      }),
    );
  }

  private canonical(flow: FlowSnapshot): string {
    if (flow.id) return `${this.base()}/flows/${flow.id}`;
    return flow.links.self ? this.absolute(flow.links.self) : '';
  }

  private absolute(href: string): string {
    if (/^https?:\/\//i.test(href)) return href;
    return new URL(href, `${this.options.authHost.replace(/\/$/, '')}/`).toString();
  }

  private readFlow(response: HttpText): FlowSnapshot {
    const body = response.text ? (JSON.parse(response.text) as Record<string, unknown>) : {};
    if (response.status >= 400 || (typeof body.code === 'string' && typeof body.message === 'string' && !body.status)) {
      throw new Error(errorMessage(body, response.status));
    }
    const links: Record<string, string> = {};
    const linkBag = (body._links ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(linkBag)) {
      if (typeof value === 'string' && value) links[key] = value;
      else if (value && typeof value === 'object' && typeof (value as { href?: unknown }).href === 'string') {
        links[key] = (value as { href: string }).href;
      }
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

export function signInStepMessage(flow: FlowSnapshot): string {
  const status = flow.status || 'unknown status';
  switch (flow.status) {
    case 'EXTERNAL_AUTHENTICATION_REQUIRED':
      return `This sign-on policy continues at an external identity provider (${status}). Use the system browser to finish sign-in.`;
    case 'PUSH_CONFIRMATION_REQUIRED':
    case 'PUSH_CONFIRMATION_TIMED_OUT':
      return `This sign-on policy is waiting for a push confirmation (${status}). Use the system browser to finish sign-in.`;
    case 'ASSERTION_REQUIRED':
      return `This sign-on policy requires a security key or biometric (${status}). Use the system browser to finish sign-in.`;
    case 'PASSWORD_EXPIRED':
    case 'MUST_CHANGE_PASSWORD':
      return `PingOne requires a password change (${status}) before sign-in can finish. Use the system browser.`;
    case 'RECOVERY_CODE_REQUIRED':
      return `Password recovery (${status}) is not completed in the app. Use the system browser.`;
    case 'VERIFICATION_REQUIRED':
    case 'VERIFICATION_CODE_REQUIRED':
      return `This account still needs verification (${status}). Use the system browser.`;
    case 'PROFILE_DATA_REQUIRED':
    case 'AGREEMENT_CONSENT_REQUIRED':
    case 'ACCOUNT_LINKING_REQUIRED':
    case 'ACCOUNT_CONFIRMATION_REQUIRED':
      return `This sign-on policy needs an extra step the app does not complete (${status}). Use the system browser.`;
    case 'FAILED':
      return `Sign-in failed (${status}). Start again or use the system browser.`;
    case 'COMPLETED_ACCEPTED':
      return `Sign-in finished without an authorization code (${status}). Start again.`;
    default: {
      const actions = Object.keys(flow.links).filter((key) => key !== 'self' && key !== 'session.reset');
      const available = actions.length > 0 ? ` Available actions: ${actions.join(', ')}.` : '';
      return `This sign-in step is not supported in the app (${status}).${available} Use the system browser if it is enabled.`;
    }
  }
}

function rejectedStep(flow: FlowSnapshot, link: string): string {
  const status = flow.status || 'unknown status';
  const actions = Object.keys(flow.links).filter((key) => key !== 'self' && key !== 'session.reset');
  const available = actions.length > 0 ? actions.join(', ') : 'none';
  return `Sign-in status ${status} does not accept ${link}. Available actions: ${available}.`;
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
