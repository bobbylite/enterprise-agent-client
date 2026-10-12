import { base64UrlEncode, randomToken } from '../ids';

export interface PkcePair {
  verifier: string;
  challenge: string;
  state: string;
}

export async function createPkce(): Promise<PkcePair> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return {
    verifier,
    challenge: base64UrlEncode(new Uint8Array(digest)),
    state: randomToken(16),
  };
}
