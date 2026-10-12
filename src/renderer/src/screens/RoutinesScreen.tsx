import { useEffect, useState } from 'react';
import type { AgentProfile, Room, Routine, RoutineRun } from '@shared/types';
import { Field } from '../components/Markdown';

export function RoutinesScreen() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [targetType, setTargetType] = useState<'agent' | 'room'>('agent');
  const [targetId, setTargetId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState('');

  async function load(id?: string): Promise<void> {
    const [nextRoutines, nextAgents, nextRooms] = await Promise.all([
      window.agent.listRoutines(),
      window.agent.listAgents(),
      window.agent.listRooms(),
    ]);
    setRoutines(nextRoutines);
    setAgents(nextAgents);
    setRooms(nextRooms);
    const current = nextRoutines.find((item) => item.id === (id || selected));
    if (current) {
      setSelected(current.id);
      setName(current.name);
      setPrompt(current.prompt);
      setCron(current.cron);
      setTargetType(current.targetType);
      setTargetId(current.targetId);
      setEnabled(current.enabled);
      setRuns(await window.agent.listRoutineRuns(current.id));
    } else if (!targetId && nextAgents[0]) {
      setTargetId(nextAgents[0].id);
    }
  }

  useEffect(() => {
    void load().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    // load() is called once on mount; later refreshes call it directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const targets = targetType === 'room' ? rooms.map((room) => ({ id: room.id, name: room.name })) : agents.map((agent) => ({ id: agent.id, name: agent.name }));

  return (
    <div className="page">
      <header className="pane-head">
        <h2>Routines</h2>
        <p>Saved prompts run on a cron schedule while the app is open. Closed-app schedules are not part of this version.</p>
      </header>
      <div className="split page-split">
        <div className="list-pane">
          <button
            type="button"
            className="primary"
            onClick={() => {
              setSelected('');
              setName('');
              setPrompt('');
              setCron('0 9 * * 1-5');
              setEnabled(false);
              setRuns([]);
            }}
          >
            New routine
          </button>
          {routines.map((routine) => (
            <button key={routine.id} type="button" className={routine.id === selected ? 'list-item selected' : 'list-item'} onClick={() => void load(routine.id)}>
              {routine.name}
              <span>{routine.enabled ? routine.cron : 'paused'}</span>
            </button>
          ))}
        </div>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void window.agent
              .saveRoutine({ id: selected || undefined, name, prompt, cron, targetType, targetId, enabled })
              .then((saved) => load(saved.id))
              .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
          }}
        >
          <Field label="Name">
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Prompt">
            <textarea value={prompt} rows={5} onChange={(event) => setPrompt(event.target.value)} />
          </Field>
          <Field label="Cron (minute hour day month weekday)">
            <input value={cron} onChange={(event) => setCron(event.target.value)} />
          </Field>
          <div className="row">
            <Field label="Target">
              <select value={targetType} onChange={(event) => setTargetType(event.target.value as 'agent' | 'room')}>
                <option value="agent">Agent</option>
                <option value="room">Room</option>
              </select>
            </Field>
            <Field label="Who">
              <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            Enabled while the app is open
          </label>
          {error ? <p className="error">{error}</p> : null}
          <div className="row">
            <button className="primary" type="submit">
              Save
            </button>
            {selected ? (
              <>
                <button
                  type="button"
                  onClick={() =>
                    void window.agent
                      .runRoutine(selected)
                      .then(() => load(selected))
                      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
                  }
                >
                  Run now
                </button>
                <button type="button" className="ghost" onClick={() => void window.agent.deleteRoutine(selected).then(() => { setSelected(''); return load(); })}>
                  Delete
                </button>
              </>
            ) : null}
          </div>
          {runs.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Status</th>
                  <th>Output</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>{new Date(run.startedAt).toLocaleString()}</td>
                    <td>{run.status}</td>
                    <td>{run.error || run.output || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </form>
      </div>
    </div>
  );
}
