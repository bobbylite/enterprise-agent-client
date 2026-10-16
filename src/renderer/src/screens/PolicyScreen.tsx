import { useEffect, useRef, useState } from 'react';
import type { AppState, AuditView, PolicyView } from '@shared/types';

export function PolicyScreen({ onState }: { onState: (state: AppState) => void }) {
  const [policies, setPolicies] = useState<PolicyView[]>([]);
  const [preview, setPreview] = useState<PolicyView[] | null>(null);
  const [audit, setAudit] = useState<AuditView[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [introspectionNote, setIntrospectionNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [enforcement, setEnforcement] = useState<{ policy: PolicyView; enabled: boolean } | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const busyRef = useRef(false);

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

  useEffect(() => {
    if (!enforcement && !resetOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setEnforcement(null);
        setResetOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enforcement, resetOpen]);

  async function run(action: () => Promise<void>): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      busyRef.current = false;
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
              const state = await window.agent.getState();
              onState(state);
              setNotice(
                state.mode === 'pingone'
                  ? 'Refreshed from PingOne. Refresh only lists policies. It does not create any.'
                  : 'Refreshed.',
              );
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
              setIntrospectionNote(result.introspectionNote ?? '');
              setNotice('Review the starter policies, then confirm to create any that are missing.');
            })
          }
        >
          Scaffold policy
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await window.agent.dryRunAuthorizePolicy();
              setNotice(
                `Dry run wrote the policy tree to ${result.path}. Nothing was written to PingOne.${result.introspectionNote ? `\n${result.introspectionNote}` : ''}`,
              );
            })
          }
        >
          Dry run policy tree
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={() => setResetOpen(true)}>
          Reset local policy cache
        </button>
      </div>
      {preview ? (
        <section className="card stack">
          <h3>Starter policies</h3>
          <p className="muted">
            Confirming creates starter policies that PingOne does not currently have. Ones deleted there are created again. A second confirm does not duplicate the ones still there.
          </p>
          {introspectionNote ? <p className="muted">{introspectionNote}</p> : null}
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
                  const state = await window.agent.getState();
                  onState(state);
                  const already = state.mode === 'pingone' ? 'Those starter policies are already in PingOne.' : 'Those starter policies were already stored.';
                  const createdNote =
                    result.created.length === 0
                      ? already
                      : `Created ${result.created.length} starter ${result.created.length === 1 ? 'policy' : 'policies'}.`;
                  const credentials = result.introspectionNote ?? introspectionNote;
                  setNotice(credentials ? `${createdNote}\n${credentials}` : createdNote);
                })
              }
            >
              {busy ? 'Scaffolding…' : 'Confirm scaffold'}
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setPreview(null)}>
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
            <div className="row">
              <button
                type="button"
                className={policy.enabled ? 'danger' : 'primary'}
                disabled={busy}
                onClick={() => setEnforcement({ policy, enabled: !policy.enabled })}
              >
                {policy.enabled ? 'Turn enforcement off' : 'Turn enforcement on'}
              </button>
            </div>
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
      {resetOpen ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="policy-reset-title">
            <p className="eyebrow">Policy</p>
            <h2 id="policy-reset-title">Reset local policy cache</h2>
            <p>
              This clears the policies stored on this computer, the Authorize decision cache, and any scaffold still in progress. It does not delete anything in PingOne. Refresh only lists what PingOne has. Only Confirm scaffold creates policies.
            </p>
            <div className="row">
              <button type="button" className="ghost" disabled={busy} onClick={() => setResetOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                autoFocus
                onClick={() => {
                  setResetOpen(false);
                  void run(async () => {
                    const reset = await window.agent.resetPolicyCache();
                    setPolicies(reset.policies);
                    setPreview(null);
                    setAudit(await window.agent.listAudit());
                    onState(await window.agent.getState());
                    setNotice(reset.cleared);
                  });
                }}
              >
                Reset local policy cache
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {enforcement ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="policy-confirm-title">
            <p className="eyebrow">Policy</p>
            <h2 id="policy-confirm-title">{enforcement.enabled ? 'Enable enforcement' : 'Disable enforcement'}</h2>
            <p>
              {enforcement.enabled ? 'Enable' : 'Disable'} enforcement for {enforcement.policy.name}?
            </p>
            <div className="row">
              <button type="button" className="ghost" disabled={busy} onClick={() => setEnforcement(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={enforcement.enabled ? 'primary' : 'danger'}
                disabled={busy}
                autoFocus
                onClick={() => {
                  const { policy, enabled } = enforcement;
                  setEnforcement(null);
                  void run(async () => {
                    setPolicies(await window.agent.setPolicyEnabled(policy.id, enabled));
                    setAudit(await window.agent.listAudit());
                    onState(await window.agent.getState());
                    setNotice(`${policy.name} is now ${enabled ? 'enabled' : 'disabled'}.`);
                  });
                }}
              >
                {enforcement.enabled ? 'Turn enforcement on' : 'Turn enforcement off'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
