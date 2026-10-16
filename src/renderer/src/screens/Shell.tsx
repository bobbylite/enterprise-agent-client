import { useEffect, useState } from 'react';
import { riskIndicatorClass } from '@shared/protect/reasons';
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
  const riskClass = riskIndicatorClass(state.risk?.level);
  const chatMode = state.features.chat;
  const agentLocked = !state.features.agentConfig;
  const extensionLocked = !state.features.extensionConfig;
  const canScaffold = Boolean(state.session?.admin && state.features.policyTab);

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
        {state.restriction ? (
          <div className={`notice access-notice${chatMode === 'locked' ? ' locked-banner' : ''}`}>
            <p>{state.restriction.message}</p>
            {canScaffold ? (
              <button type="button" className="primary" onClick={() => setView('policy')}>
                Scaffold policies
              </button>
            ) : null}
          </div>
        ) : null}
        {view === 'chat' ? <ChatScreen branding={branding} showReasoning={state.showReasoning} chatMode={chatMode} /> : null}
        {view === 'rooms' ? (
          <RoomsScreen showReasoning={state.showReasoning} chatMode={chatMode} configLocked={agentLocked} />
        ) : null}
        {view === 'agents' ? <AgentsScreen branding={branding} configLocked={agentLocked} /> : null}
        {view === 'tools' ? <McpScreen configLocked={extensionLocked} /> : null}
        {view === 'policy' && showPolicy ? <PolicyScreen onState={onState} /> : null}
        {view === 'settings' ? <SettingsScreen state={state} /> : null}
      </section>
      <ApprovalModal />
    </div>
  );
}
