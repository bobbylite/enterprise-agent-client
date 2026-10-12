export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  tokenType: string;
  scope?: string;
}

export type TokenFreshness = 'valid' | 'refresh' | 'reauth';

export function readTokenResponse(body: unknown, now: number): TokenSet {
  const record = (body ?? {}) as Record<string, unknown>;
  if (typeof record.access_token !== 'string' || record.access_token === '') {
    const message =
      (typeof record.error_description === 'string' && record.error_description) ||
      (typeof record.error === 'string' && record.error) ||
      'Token response did not include an access token.';
    throw new Error(message);
  }
  const expiresIn = Number(record.expires_in ?? 3600);
  const lifetime = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
  return {
    accessToken: record.access_token,
    refreshToken: typeof record.refresh_token === 'string' ? record.refresh_token : undefined,
    idToken: typeof record.id_token === 'string' ? record.id_token : undefined,
    expiresAt: now + lifetime * 1000,
    tokenType: typeof record.token_type === 'string' ? record.token_type : 'Bearer',
    scope: typeof record.scope === 'string' ? record.scope : undefined,
  };
}

export function classifyAccessToken(
  token: { expiresAt: number; refreshToken?: string },
  now: number,
  skewMs = 60_000,
): TokenFreshness {
  if (now < token.expiresAt - skewMs) return 'valid';
  if (token.refreshToken) return 'refresh';
  return 'reauth';
}

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
