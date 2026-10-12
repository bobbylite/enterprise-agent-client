import { useEffect, useState } from 'react';
import type { InspectedToken, SessionView } from '@shared/types';

export function TokenInspector({ session }: { session: SessionView | null }) {
  const [tokens, setTokens] = useState<InspectedToken[]>([]);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const userId = session?.userId ?? '';

  useEffect(() => {
    if (!userId) {
      setTokens([]);
      setRevealed({});
      return;
    }
    let cancelled = false;
    void window.agent
      .listTokens()
      .then((listed) => {
        if (!cancelled) setTokens(listed);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function reexchange(id: string): Promise<void> {
    setBusy(id);
    setError('');
    setNotice('');
    try {
      const next = await window.agent.reexchangeToken(id);
      setTokens((current) => current.map((token) => (token.id === id ? next : token)));
      setRevealed((current) => {
        const copy = { ...current };
        delete copy[id];
        return copy;
      });
      setNotice(id === 'session' ? 'Session token replaced.' : 'Audience token re-exchanged.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy('');
    }
  }

  async function toggleReveal(id: string): Promise<void> {
    if (revealed[id]) {
      setRevealed((current) => {
        const copy = { ...current };
        delete copy[id];
        return copy;
      });
      return;
    }
    setBusy(id);
    setError('');
    try {
      const token = await window.agent.revealToken(id);
      setRevealed((current) => ({ ...current, [id]: token }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy('');
    }
  }

  async function copyToken(id: string): Promise<void> {
    const token = revealed[id];
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setNotice('Token copied.');
    } catch {
      setError('The clipboard is not available.');
    }
  }

  return (
    <section className="token-inspector">
      <header className="pane-head">
        <h2>Tokens</h2>
        <p>PingOne session and RFC 8693 audience tokens for this sign-in. Raw tokens stay hidden until you reveal them.</p>
      </header>
      {!session ? <p className="muted">Sign in to inspect tokens.</p> : null}
      {tokens.map((token) => {
        const raw = revealed[token.id];
        return (
          <article key={token.id} className="card token-card">
            <div className="row">
              <strong>{token.kind === 'session' ? 'PingOne session' : 'Exchanged token'}</strong>
              <span className="muted">{token.label}</span>
            </div>
            <dl className="claims">
              <dt>Header</dt>
              <dd>{formatHeader(token.header)}</dd>
              <dt>aud</dt>
              <dd>{token.aud ?? '—'}</dd>
              <dt>scope</dt>
              <dd>{token.scope ?? '—'}</dd>
              <dt>sub</dt>
              <dd>{token.sub ?? '—'}</dd>
              <dt>act</dt>
              <dd>{formatValue(token.act)}</dd>
              <dt>may_act</dt>
              <dd>{formatValue(token.mayAct)}</dd>
              <dt>iat</dt>
              <dd>{formatUnix(token.iat)}</dd>
              <dt>exp</dt>
              <dd>{formatUnix(token.exp)}</dd>
              <dt>Expires in</dt>
              <dd>{formatRemaining(token.expiresAt, now)}</dd>
            </dl>
            {token.error ? <p className="error">{token.error}</p> : null}
            <div className="row">
              <button type="button" className="ghost" disabled={busy === token.id || !session} onClick={() => void reexchange(token.id)}>
                Re-exchange now
              </button>
              <button type="button" className="ghost" disabled={busy === token.id || !token.present} onClick={() => void toggleReveal(token.id)}>
                {raw ? 'Hide token' : 'Reveal token'}
              </button>
              {raw ? (
                <button type="button" className="ghost" onClick={() => void copyToken(token.id)}>
                  Copy
                </button>
              ) : null}
            </div>
            {raw ? <pre className="jwt">{raw}</pre> : <p className="muted">Raw JWT hidden.</p>}
          </article>
        );
      })}
      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}

function formatHeader(header: Record<string, unknown>): string {
  const parts = ['alg', 'typ', 'kid']
    .filter((key) => header[key] != null)
    .map((key) => `${key}=${String(header[key])}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function formatValue(value: unknown): string {
  if (value == null || value === '') return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function formatUnix(seconds: number | null): string {
  if (seconds == null) return '—';
  return new Date(seconds * 1000).toLocaleString();
}

function formatRemaining(expiresAt: number | null, now: number): string {
  if (expiresAt == null) return 'No expiry';
  const ms = expiresAt - now;
  if (ms <= 0) return 'Expired';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'Less than a minute';
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}
