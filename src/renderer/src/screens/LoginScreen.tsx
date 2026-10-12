import { useState } from 'react';
import type { AppState, Branding, MockScenario } from '@shared/types';
import { Field } from '../components/Markdown';
import { collectProtectSignals } from '../signals';

const SCENARIOS: { id: MockScenario; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'new_device', label: 'New device' },
  { id: 'anomalous_location', label: 'Anomalous location' },
  { id: 'impossible_travel', label: 'Impossible travel' },
  { id: 'bot', label: 'Bot' },
];

export function LoginScreen({
  branding,
  state,
  onState,
}: {
  branding: Branding;
  state: AppState;
  onState: (state: AppState) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const phase = state.login.phase;

  async function run(action: () => Promise<AppState>): Promise<void> {
    setBusy(true);
    setError('');
    try {
      onState(await action());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const signals = () => collectProtectSignals(state.mode);

  return (
    <main className="login">
      <section className="login-brand">
        {branding.logoDataUrl ? <img className="logo" src={branding.logoDataUrl} alt="" /> : <div className="monogram">{branding.appName.slice(0, 1)}</div>}
        <h1>{branding.appName}</h1>
        <p className="tagline">{branding.tagline}</p>
        <p>{branding.about}</p>
      </section>
      <section className="login-panel">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (phase === 'otp') {
              void run(async () => window.agent.submitOtp(otp, await signals()));
              return;
            }
            void run(async () => window.agent.submitCredentials(username, password, await signals()));
          }}
        >
          <p className="eyebrow">{state.mode === 'mock' ? 'Mock sign-in' : 'Organization sign-in'}</p>
          <h2>{phase === 'blocked' ? 'Session blocked' : `Sign in to ${branding.appName}`}</h2>
          {state.login.message ? <p className="notice">{state.login.message}</p> : null}
          {state.mode === 'mock' && phase !== 'blocked' ? (
            <div className="scenario">
              <span>Demo risk</span>
              <div className="segment">
                {SCENARIOS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={state.mockScenario === item.id ? 'selected' : ''}
                    onClick={() => void run(() => window.agent.setMockScenario(item.id))}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <p className="muted">Mock mode accepts any non-empty password and does not contact PingOne.</p>
            </div>
          ) : null}

          {phase === 'blocked' && state.risk ? (
            <div className="risk-card danger">
              <strong>{state.risk.level}</strong>
              <ul>
                {state.risk.reasons.length === 0 ? <li>No predictor detail was returned.</li> : null}
                {state.risk.reasons.map((reason) => (
                  <li key={reason.code}>
                    {reason.label}
                    {reason.detail ? ` — ${reason.detail}` : ''}
                  </li>
                ))}
              </ul>
              <button type="button" onClick={() => void run(() => window.agent.cancelLogin())}>
                Back to sign-in
              </button>
            </div>
          ) : null}

          {phase === 'device' ? (
            <div className="stack">
              {(state.login.devices ?? []).map((device) => (
                <button
                  key={device.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void run(async () => window.agent.selectDevice(device.id, await signals()))}
                >
                  {device.label}
                </button>
              ))}
            </div>
          ) : null}

          {phase === 'otp' || state.login.stepUp ? (
            phase !== 'blocked' && phase !== 'error' ? (
              <Field label="Verification code">
                <input value={otp} onChange={(event) => setOtp(event.target.value)} inputMode="numeric" autoComplete="one-time-code" />
              </Field>
            ) : null
          ) : null}

          {(phase === 'idle' || phase === 'credentials' || phase === 'error') && state.loginPreferred !== 'system-browser' ? (
            <>
              <Field label="Username">
                <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
              </Field>
              <Field label="Password">
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
              </Field>
            </>
          ) : null}

          {error || (phase === 'error' ? state.login.message : '') ? <p className="error">{error || state.login.message}</p> : null}

          <div className="row">
            {phase === 'otp' ? (
              <button className="primary" type="submit" disabled={busy}>
                Verify
              </button>
            ) : null}
            {(phase === 'idle' || phase === 'credentials') && state.loginPreferred !== 'system-browser' ? (
              <button className="primary" type="submit" disabled={busy}>
                Continue
              </button>
            ) : null}
            {state.loginPreferred === 'system-browser' || state.allowSystemBrowserFallback ? (
              <button
                type="button"
                className={state.loginPreferred === 'system-browser' ? 'primary' : 'ghost'}
                disabled={busy || phase === 'blocked'}
                onClick={() => void run(async () => window.agent.startSystemBrowserLogin(await signals()))}
              >
                {state.mode === 'mock' ? 'Mock system-browser sign-in' : 'Use system browser'}
              </button>
            ) : null}
            {phase !== 'idle' && phase !== 'credentials' ? (
              <button type="button" className="ghost" onClick={() => void run(() => window.agent.cancelLogin())}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      </section>
    </main>
  );
}
