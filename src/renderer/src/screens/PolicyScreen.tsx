import { useEffect, useState } from 'react';
import type { AppState, AuditView, PolicyView } from '@shared/types';

export function PolicyScreen({ onState }: { onState: (state: AppState) => void }) {
  const [policies, setPolicies] = useState<PolicyView[]>([]);
  const [preview, setPreview] = useState<PolicyView[] | null>(null);
  const [audit, setAudit] = useState<AuditView[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    const [nextPolicies, nextAudit, nextState] = await Promise.all([
      window.agent.listPolicies(),
      window.agent.listAudit(),
      window.agent.getState(),
    ]);
    setPolicies(nextPolicies);
    setAudit(nextAudit);
    onState(nextState);
  }

  useEffect(() => {
    void load().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    // Load the policy list once when the tab opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page stack">
      <header className="pane-head">
        <h2>Policy</h2>
        <p>PingOne Authorize policies decide which features this session can use. Enforcement changes ask for confirmation.</p>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="notice">{notice}</p> : null}
      <div className="row">
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setPolicies(await window.agent.refreshPolicies());
              setAudit(await window.agent.listAudit());
              onState(await window.agent.getState());
              setNotice('Refreshed from PingOne.');
            })
          }
        >
          Refresh
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await window.agent.scaffoldPolicies(false);
              setPreview(result.preview);
              setNotice('Review the starter policies, then confirm to create any that are missing.');
            })
          }
        >
          Scaffold policy
        </button>
      </div>
      {preview ? (
        <section className="card stack">
          <h3>Starter policies</h3>
          <p className="muted">
            Confirming creates only the policies that are not already stored. A second confirm does not duplicate them.
          </p>
          <ul className="tools">
            {preview.map((policy) => (
              <li key={policy.id}>
                <strong>{policy.name}</strong>
                <span>{policy.description}</span>
              </li>
            ))}
          </ul>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await window.agent.scaffoldPolicies(true);
                  setPolicies(result.policies);
                  setPreview(null);
                  setAudit(await window.agent.listAudit());
                  onState(await window.agent.getState());
                  setNotice(
                    result.created.length === 0
                      ? 'Those starter policies were already present.'
                      : `Created ${result.created.length} starter ${result.created.length === 1 ? 'policy' : 'policies'}.`,
                  );
                })
              }
            >
              Confirm scaffold
            </button>
            <button type="button" className="ghost" onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </section>
      ) : null}
      {policies.length === 0 ? <p>No Authorize policies yet. Scaffold a starter set to begin.</p> : null}
      <div className="cards">
        {policies.map((policy) => (
          <article key={policy.id} className="card stack">
            <h3>{policy.name}</h3>
            <p>{policy.description}</p>
            <p className="muted">
              {policy.enabled ? 'Enforcement on' : 'Enforcement off'}
              {policy.updatedAt ? ` · ${new Date(policy.updatedAt).toLocaleString()}` : ''}
              {policy.updatedBy ? ` · ${policy.updatedBy}` : ''}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const next = !policy.enabled;
                if (!window.confirm(`${next ? 'Enable' : 'Disable'} enforcement for ${policy.name}?`)) return;
                void run(async () => {
                  setPolicies(await window.agent.setPolicyEnabled(policy.id, next));
                  setAudit(await window.agent.listAudit());
                  onState(await window.agent.getState());
                  setNotice(`${policy.name} is now ${next ? 'enabled' : 'disabled'}.`);
                });
              }}
            >
              {policy.enabled ? 'Turn enforcement off' : 'Turn enforcement on'}
            </button>
          </article>
        ))}
      </div>
      <section className="stack">
        <h3>Admin audit</h3>
        {audit.length === 0 ? <p className="muted">No admin actions yet.</p> : null}
        <ul className="tools">
          {audit.map((event) => (
            <li key={event.id}>
              <strong>{event.action}</strong>
              <span>
                {event.username || event.userId}
                {event.agentId ? ` · agent ${event.agentId}` : ''} · {new Date(event.at).toLocaleString()}
              </span>
              <span>{event.detail}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
