import type { SecretStore } from '../secrets';
import {
  ACCESS_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT,
  classifyAccessToken,
  readTokenResponse,
  type TokenSet,
} from '../auth/tokens';

export interface ExchangeRequest {
  tokenEndpoint: string;
  subjectToken: string;
  audience: string;
  scope?: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function exchangeSubjectToken(input: ExchangeRequest): Promise<TokenSet> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const body = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: input.subjectToken,
    subject_token_type: ACCESS_TOKEN_TYPE,
    requested_token_type: ACCESS_TOKEN_TYPE,
    audience: input.audience,
    client_id: input.clientId,
  });
  if (input.scope) body.set('scope', input.scope);
  const basic = btoa(`${input.clientId}:${input.clientSecret}`);
  const response = await fetchImpl(input.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message =
      (parsed as { error_description?: string; error?: string }).error_description ||
      (parsed as { error?: string }).error ||
      `Token exchange failed (${response.status}).`;
    throw new Error(message);
  }
  return readTokenResponse(parsed, now());
}

export async function fetchClientCredentials(input: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<TokenSet> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: input.clientId,
  });
  if (input.scope) body.set('scope', input.scope);
  const basic = btoa(`${input.clientId}:${input.clientSecret}`);
  const response = await fetchImpl(input.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(
      (parsed as { error_description?: string }).error_description ||
        `Client credentials grant failed (${response.status}).`,
    );
  }
  return readTokenResponse(parsed, now());
}

export class AudienceTokenCache {
  constructor(
    private readonly store: SecretStore,
    private readonly skewMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(audience: string): Promise<TokenSet | null> {
    const raw = await this.store.get(account(audience));
    if (!raw) return null;
    const token = JSON.parse(raw) as TokenSet;
    if (classifyAccessToken(token, this.now(), this.skewMs) !== 'valid') return null;
    return token;
  }

  async put(audience: string, token: TokenSet): Promise<void> {
    await this.store.set(account(audience), JSON.stringify(token));
  }

  async clear(): Promise<void> {
    // Callers delete known audiences. There is no list API on the secret store.
  }
}

function account(audience: string): string {
  return `audience:${audience}`;
}

export async function getOrExchange(input: ExchangeRequest & { cache: AudienceTokenCache }): Promise<TokenSet> {
  const cached = await input.cache.get(input.audience);
  if (cached) return cached;
  const fresh = await exchangeSubjectToken(input);
  await input.cache.put(input.audience, fresh);
  return fresh;
}
