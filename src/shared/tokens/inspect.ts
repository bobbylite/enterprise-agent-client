import { decodeJwtHeader, decodeJwtPayload } from '../ids';

export interface JwtInspection {
  header: Record<string, unknown>;
  aud: string | null;
  scope: string | null;
  sub: string | null;
  act: unknown;
  mayAct: unknown;
  exp: number | null;
  iat: number | null;
  expiresAt: number | null;
  expiresInMs: number | null;
}

export function inspectJwt(
  token: string,
  now: number,
  fallback: { scope?: string; expiresAt?: number } = {},
): JwtInspection {
  const header = decodeJwtHeader(token);
  const payload = decodeJwtPayload(token);
  const exp = unixSeconds(payload.exp);
  const iat = unixSeconds(payload.iat);
  const expiresAt = exp != null ? exp * 1000 : fallback.expiresAt ?? null;
  return {
    header,
    aud: claimText(payload.aud),
    scope: claimText(payload.scope) ?? claimText(payload.scp) ?? fallback.scope ?? null,
    sub: claimText(payload.sub),
    act: payload.act ?? null,
    mayAct: payload.may_act ?? null,
    exp,
    iat,
    expiresAt,
    expiresInMs: expiresAt == null ? null : expiresAt - now,
  };
}

function unixSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function claimText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(claimText).filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join(' ') : null;
  }
  return null;
}
