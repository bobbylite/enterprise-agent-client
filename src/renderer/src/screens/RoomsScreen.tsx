import { useEffect, useState } from 'react';
import type { AgentProfile, ChatSnapshot, Room } from '@shared/types';
import { applyChatEvent } from '../chat-events';
import { Field } from '../components/Markdown';
import { Transcript } from '../components/Transcript';

export function RoomsScreen({ showReasoning }: { showReasoning: boolean }) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [selected, setSelected] = useState<Room | null>(null);
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [draft, setDraft] = useState('');
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(id?: string): Promise<void> {
    const [nextRooms, nextAgents] = await Promise.all([window.agent.listRooms(), window.agent.listAgents()]);
    setRooms(nextRooms);
    setAgents(nextAgents);
    const room = nextRooms.find((item) => item.id === (id || selected?.id)) ?? nextRooms[0] ?? null;
    setSelected(room);
    if (room) {
      setName(room.name);
      setInstructions(room.instructions);
      setAgentIds(room.agentIds);
      setSnapshot(await window.agent.openRoom(room.id));
    } else {
      setSnapshot(null);
    }
  }

  useEffect(() => {
    void load().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    return window.agent.onChatEvent((event) => {
      setSnapshot((current) => applyChatEvent(current, event));
    });
    // load() is called once on mount; later refreshes call it directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="split">
      <div className="list-pane">
        <button
          type="button"
          className="primary"
          onClick={() => {
            setSelected(null);
            setSnapshot(null);
            setName('');
            setInstructions('');
            setAgentIds(agents[0] ? [agents[0].id] : []);
          }}
        >
          New room
        </button>
        {rooms.map((room) => (
          <button key={room.id} type="button" className={room.id === selected?.id ? 'list-item selected' : 'list-item'} onClick={() => void load(room.id)}>
            {room.name}
          </button>
        ))}
      </div>
      <div className="conversation">
        <header className="pane-head">
          <h2>{selected ? selected.name : 'New room'}</h2>
          <p>Pick agents from the Agents list. They share these room instructions and reply in turn.</p>
        </header>
        <form
          className="stack compact"
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              const saved = await window.agent.saveRoom({ id: selected?.id, name, instructions, agentIds });
              await load(saved.id);
            })().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
          }}
        >
          <Field label="Room name">
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Room instructions">
            <textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={3} />
          </Field>
          <div className="checks">
            {agents.map((agent) => (
              <label key={agent.id}>
                <input
                  type="checkbox"
                  checked={agentIds.includes(agent.id)}
                  onChange={(event) =>
                    setAgentIds((current) =>
                      event.target.checked ? [...current, agent.id] : current.filter((id) => id !== agent.id),
                    )
                  }
                />
                {agent.name}
              </label>
            ))}
          </div>
          <div className="row">
            <button className="primary" type="submit">
              Save room
            </button>
            {selected ? (
              <>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    if (!selected) return;
                    if (!window.confirm("Delete this room's messages? The room, its agents, instructions, and routines stay.")) return;
                    void window.agent
                      .deleteRoomHistory(selected.id)
                      .then(() => window.agent.openRoom(selected.id))
                      .then(setSnapshot)
                      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
                  }}
                >
                  Delete history
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void window.agent.deleteRoom(selected.id).then(() => load())}
                >
                  Delete room
                </button>
              </>
            ) : null}
          </div>
        </form>
        {snapshot ? <Transcript messages={snapshot.messages} showReasoning={showReasoning} /> : null}
        {error ? <p className="error">{error}</p> : null}
        {selected ? (
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (!selected) return;
              setBusy(true);
              const text = draft;
              setDraft('');
              void window.agent
                .sendRoomMessage(selected.id, text)
                .then(() => window.agent.openRoom(selected.id))
                .then(setSnapshot)
                .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
                .finally(() => setBusy(false));
            }}
          >
            <textarea value={draft} placeholder="Message the room" onChange={(event) => setDraft(event.target.value)} />
            {busy ? (
              <button className="primary" type="button" onClick={() => snapshot && void window.agent.stopGeneration(snapshot.conversation.id)}>
                Stop
              </button>
            ) : (
              <button className="primary" type="submit">
                Send
              </button>
            )}
          </form>
        ) : null}
      </div>
    </div>
  );
}
