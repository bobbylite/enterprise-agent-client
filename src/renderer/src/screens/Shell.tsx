import { useEffect, useState } from 'react';
import type { AppState, Branding } from '@shared/types';
import { ApprovalModal } from '../components/ApprovalModal';
import { AgentsScreen } from './AgentsScreen';
import { ChatScreen } from './ChatScreen';
import { McpScreen } from './McpScreen';
import { PolicyScreen } from './PolicyScreen';
import { RoomsScreen } from './RoomsScreen';
import { SettingsScreen } from './SettingsScreen';

const NAV = [
  ['chat', 'Chat'],
  ['rooms', 'Rooms'],
  ['agents', 'Agents'],
  ['tools', 'Tools'],
  ['policy', 'Policy'],
  ['settings', 'Settings'],
] as const;

export function Shell({
  branding,
  state,
  onState,
}: {
  branding: Branding;
  state: AppState;
  onState: (state: AppState) => void;
}) {
  const showPolicy = Boolean(state.session?.admin && state.features.policyTab);
  const nav = NAV.filter(([id]) => id !== 'policy' || showPolicy);
  const [view, setView] = useState<(typeof NAV)[number][0]>('chat');
  const riskClass = state.risk?.action === 'block' ? 'danger' : state.risk?.action === 'allow' ? 'good' : 'warn';
  const readOnly = state.features.chat === 'read_only';

  useEffect(() => {
    if (view === 'policy' && !showPolicy) setView('chat');
  }, [showPolicy, view]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          {branding.logoDataUrl ? <img src={branding.logoDataUrl} alt="" /> : <div className="monogram">{branding.appName.slice(0, 1)}</div>}
          <div>
            <strong>{branding.appName}</strong>
            <span>{branding.agentName}</span>
          </div>
        </div>
        {state.risk ? (
          <div className={`risk-stamp ${riskClass}`}>
            <span>{state.risk.level}</span>
            <p>{state.risk.summary}</p>
          </div>
        ) : null}
        <nav>
          {nav.map(([id, label]) => (
            <button key={id} type="button" className={view === id ? 'nav selected' : 'nav'} onClick={() => setView(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span>{state.session?.username}</span>
          <button
            type="button"
            className="ghost"
            onClick={() => void window.agent.logout().then(onState)}
          >
            Sign out
          </button>
        </div>
      </aside>
      <section className="workspace">
        {view === 'chat' ? <ChatScreen branding={branding} showReasoning={state.showReasoning} readOnly={readOnly} /> : null}
        {view === 'rooms' ? <RoomsScreen showReasoning={state.showReasoning} readOnly={readOnly} /> : null}
        {view === 'agents' ? <AgentsScreen branding={branding} /> : null}
        {view === 'tools' ? <McpScreen /> : null}
        {view === 'policy' && showPolicy ? <PolicyScreen onState={onState} /> : null}
        {view === 'settings' ? <SettingsScreen state={state} /> : null}
      </section>
      <ApprovalModal />
    </div>
  );
}
