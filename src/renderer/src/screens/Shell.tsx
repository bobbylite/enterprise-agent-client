import { useState } from 'react';
import type { AppState, Branding } from '@shared/types';
import { ApprovalModal } from '../components/ApprovalModal';
import { ChatScreen } from './ChatScreen';
import { InstructionsScreen } from './InstructionsScreen';
import { McpScreen } from './McpScreen';
import { RoomsScreen } from './RoomsScreen';
import { RoutinesScreen } from './RoutinesScreen';
import { SettingsScreen } from './SettingsScreen';

const NAV = [
  ['chat', 'Chat'],
  ['rooms', 'Rooms'],
  ['routines', 'Routines'],
  ['tools', 'Tools'],
  ['instructions', 'Instructions'],
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
  const [view, setView] = useState<(typeof NAV)[number][0]>('chat');
  const riskClass = state.risk?.action === 'block' ? 'danger' : state.risk?.action === 'allow' ? 'good' : 'warn';

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
          {NAV.map(([id, label]) => (
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
        {view === 'chat' ? <ChatScreen branding={branding} /> : null}
        {view === 'rooms' ? <RoomsScreen /> : null}
        {view === 'routines' ? <RoutinesScreen /> : null}
        {view === 'tools' ? <McpScreen /> : null}
        {view === 'instructions' ? <InstructionsScreen /> : null}
        {view === 'settings' ? <SettingsScreen state={state} /> : null}
      </section>
      <ApprovalModal />
    </div>
  );
}
