import { useEffect, useState, type ReactNode } from 'react';
import type { AgentPage, AgentProfile, Branding, InstructionFields, Room, Routine, RoutineRun } from '@shared/types';
import { Field } from '../components/Markdown';

const FIELDS: { key: keyof InstructionFields; label: string }[] = [
  { key: 'persona', label: 'Persona' },
  { key: 'communicationStyle', label: 'Communication style' },
  { key: 'autonomy', label: 'Autonomy and approvals' },
  { key: 'safety', label: 'Safety' },
  { key: 'untrustedContent', label: 'Untrusted content' },
];

const EMPTY: InstructionFields = { persona: '', communicationStyle: '', autonomy: '', safety: '', untrustedContent: '' };

export function AgentsScreen({ branding }: { branding: Branding }) {
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [page, setPage] = useState<AgentPage | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  async function load(id?: string): Promise<void> {
    const list = await window.agent.listAgents();
    setAgents(list);
    const nextId = id || page?.profile.id || list.find((agent) => agent.nameFromBranding)?.id || list[0]?.id;
    if (!nextId) {
      setPage(null);
      return;
    }
    setPage(await window.agent.openAgent(nextId));
    setCreating(false);
  }

  useEffect(() => {
    void load().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    // The first load selects the branding agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="split">
      <div className="list-pane">
        <button
          type="button"
          className="primary"
          onClick={() => {
            setCreating(true);
            setPage(null);
            setError('');
          }}
        >
          New agent
        </button>
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={!creating && agent.id === page?.profile.id ? 'list-item selected' : 'list-item'}
            onClick={() => void load(agent.id).catch((caught: unknown) => setError(String(caught)))}
          >
            {agent.name}
            <span>{agent.nameFromBranding ? 'Branding default' : agent.provider}</span>
          </button>
        ))}
      </div>
      <div className="page agent-page">
        {error ? <p className="error">{error}</p> : null}
        {creating ? (
          <CreateAgent
            onCancel={() => void load()}
            onCreated={(id) => void load(id)}
            onError={setError}
          />
        ) : page ? (
          <AgentEditor
            branding={branding}
            page={page}
            onChange={setPage}
            onSaved={(id) => void load(id)}
            onDeleted={() => void load(agents.find((agent) => agent.nameFromBranding)?.id)}
            onError={setError}
          />
        ) : (
          <p>Loading</p>
        )}
      </div>
    </div>
  );
}

function CreateAgent({
  onCancel,
  onCreated,
  onError,
}: {
  onCancel: () => void;
  onCreated: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<AgentPage['profile']['provider']>('mock');
  const [model, setModel] = useState('mock-1');

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void window.agent
          .saveAgent({ name, provider, model, persona: EMPTY, user: EMPTY })
          .then((saved) => onCreated(saved.profile.id))
          .catch((caught: unknown) => onError(caught instanceof Error ? caught.message : String(caught)));
      }}
    >
      <header className="pane-head">
        <h2>New agent</h2>
        <p>Each agent keeps its own instructions and routines. Enterprise policy still applies to all of them.</p>
      </header>
      <Field label="Name">
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <ProviderFields provider={provider} model={model} onProvider={setProvider} onModel={setModel} />
      <div className="row">
        <button className="primary" type="submit">
          Create agent
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const AGENT_TABS = [
  ['instructions', 'Instructions'],
  ['routines', 'Routines'],
  ['cron', 'Cron'],
  ['skills', 'Skills'],
] as const;

function AgentEditor({
  branding,
  page,
  onChange,
  onSaved,
  onDeleted,
  onError,
}: {
  branding: Branding;
  page: AgentPage;
  onChange: (page: AgentPage) => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
  onError: (message: string) => void;
}) {
  const profile = page.profile;
  const [tab, setTab] = useState<(typeof AGENT_TABS)[number][0]>('instructions');

  function save(next: AgentPage = page): void {
    void window.agent
      .saveAgent({
        id: next.profile.id,
        name: next.profile.name,
        provider: next.profile.provider,
        model: next.profile.model,
        persona: next.persona,
        user: next.user,
      })
      .then((saved) => onSaved(saved.profile.id))
      .catch((caught: unknown) => onError(caught instanceof Error ? caught.message : String(caught)));
  }

  return (
    <>
      <header className="pane-head">
        <div className="row">
          <h2>{profile.name}</h2>
          {profile.nameFromBranding ? null : (
            <button
              type="button"
              className="ghost danger-text"
              onClick={() => {
                if (!window.confirm(`Delete ${profile.name}? Its routines are removed. Rooms that include it keep their other agents.`)) return;
                void window.agent
                  .deleteAgent(profile.id)
                  .then(onDeleted)
                  .catch((caught: unknown) => onError(caught instanceof Error ? caught.message : String(caught)));
              }}
            >
              Delete agent
            </button>
          )}
        </div>
        <p>
          {profile.nameFromBranding
            ? `This is the branding agent. Its name follows ${branding.agentName} from branding config.`
            : 'Instructions and routines on this page belong to this agent.'}
        </p>
      </header>
      <section className="stack card">
        <h3>Profile</h3>
        {profile.nameFromBranding ? (
          <Field label="Name">
            <input value={profile.name} readOnly />
          </Field>
        ) : (
          <Field label="Name">
            <input value={profile.name} onChange={(event) => onChange({ ...page, profile: { ...profile, name: event.target.value } })} />
          </Field>
        )}
        <ProviderFields
          provider={profile.provider}
          model={profile.model}
          onProvider={(provider) => onChange({ ...page, profile: { ...profile, provider } })}
          onModel={(model) => onChange({ ...page, profile: { ...profile, model } })}
        />
        <button className="primary" type="button" onClick={() => save()}>
          Save profile
        </button>
      </section>
      <div className="segment" role="tablist">
        {AGENT_TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'instructions' ? (
        <>
          <section className="stack card locked">
            <h3>Enterprise policy</h3>
            <p className="muted">Locked by admin config. It overrides this agent's instructions.</p>
            {FIELDS.map((field) => (
              <Field key={field.key} label={field.label}>
                <textarea value={page.enterprise[field.key]} readOnly rows={3} />
              </Field>
            ))}
          </section>
          <InstructionCard
            title="Agent instructions"
            fields={page.persona}
            onChange={(persona) => onChange({ ...page, persona })}
            onSave={() => save()}
            extra={
              profile.nameFromBranding ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    const next = { ...page, persona: branding.persona };
                    onChange(next);
                    save(next);
                  }}
                >
                  Reset to branding default
                </button>
              ) : null
            }
          />
          <InstructionCard title="Your preferences" fields={page.user} onChange={(user) => onChange({ ...page, user })} onSave={() => save()} />
        </>
      ) : null}
      {tab === 'routines' ? <AgentRoutines mode="routines" agentId={profile.id} routines={page.routines} onSaved={() => onSaved(profile.id)} onError={onError} /> : null}
      {tab === 'cron' ? <AgentRoutines mode="cron" agentId={profile.id} routines={page.routines} onSaved={() => onSaved(profile.id)} onError={onError} /> : null}
      {tab === 'skills' ? <SkillsPlaceholder skillIds={page.skillIds} /> : null}
    </>
  );
}

function SkillsPlaceholder({ skillIds }: { skillIds: string[] }) {
  return (
    <section className="stack card">
      <h3>Skills</h3>
      <p className="muted">Skills assigned to this agent will be listed here. Uploading and assigning skills is not available yet.</p>
      {skillIds.length === 0 ? <p>No skills assigned.</p> : (
        <ul className="tools">
          {skillIds.map((id) => (
            <li key={id}>{id}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function InstructionCard({
  title,
  fields,
  onChange,
  onSave,
  extra,
}: {
  title: string;
  fields: InstructionFields;
  onChange: (fields: InstructionFields) => void;
  onSave: () => void;
  extra?: ReactNode;
}) {
  return (
    <section className="stack card">
      <h3>{title}</h3>
      {FIELDS.map((field) => (
        <Field key={field.key} label={field.label}>
          <textarea rows={3} value={fields[field.key]} onChange={(event) => onChange({ ...fields, [field.key]: event.target.value })} />
        </Field>
      ))}
      <div className="row">
        <button className="primary" type="button" onClick={onSave}>
          Save
        </button>
        {extra}
      </div>
    </section>
  );
}

function ProviderFields({
  provider,
  model,
  onProvider,
  onModel,
}: {
  provider: AgentProfile['provider'];
  model: string;
  onProvider: (provider: AgentProfile['provider']) => void;
  onModel: (model: string) => void;
}) {
  return (
    <div className="row">
      <Field label="Provider">
        <select value={provider} onChange={(event) => onProvider(event.target.value as AgentProfile['provider'])}>
          <option value="mock">Mock</option>
          <option value="openai">OpenAI-compatible</option>
          <option value="anthropic">Anthropic</option>
          <option value="generic">Generic HTTP</option>
        </select>
      </Field>
      <Field label="Model">
        <input value={model} onChange={(event) => onModel(event.target.value)} />
      </Field>
    </div>
  );
}

function AgentRoutines({
  mode,
  agentId,
  routines,
  onSaved,
  onError,
}: {
  mode: 'routines' | 'cron';
  agentId: string;
  routines: Routine[];
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [targetType, setTargetType] = useState<'agent' | 'room'>('agent');
  const [targetId, setTargetId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [runs, setRuns] = useState<RoutineRun[]>([]);

  useEffect(() => {
    void window.agent.listRooms().then(setRooms).catch((caught: unknown) => onError(String(caught)));
  }, [onError]);

  function select(routine: Routine | undefined): void {
    setSelected(routine?.id ?? '');
    setName(routine?.name ?? '');
    setPrompt(routine?.prompt ?? '');
    setCron(routine?.cron ?? '0 9 * * 1-5');
    setTargetType(routine?.targetType ?? 'agent');
    setTargetId(routine?.targetType === 'room' ? routine.targetId : '');
    setEnabled(routine?.enabled ?? false);
    if (routine) {
      void window.agent.listRoutineRuns(routine.id).then(setRuns);
    } else {
      setRuns([]);
    }
  }

  return (
    <section className="stack card">
      <h3>{mode === 'cron' ? 'Cron' : 'Routines'}</h3>
      <p className="muted">
        {mode === 'cron'
          ? 'Schedules run while the app is open. The prompt for each task is edited on Routines.'
          : 'Saved prompts for this agent. Set when they run on the Cron tab.'}
      </p>
      <div className="row">
        {mode === 'routines' ? (
          <button type="button" className="ghost" onClick={() => select(undefined)}>
            New routine
          </button>
        ) : null}
        {routines.map((routine) => (
          <button key={routine.id} type="button" className={routine.id === selected ? 'list-item selected' : 'list-item'} onClick={() => select(routine)}>
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
            .saveRoutine({
              id: selected || undefined,
              name,
              prompt,
              cron,
              agentId,
              targetType,
              targetId: targetType === 'room' ? targetId : agentId,
              enabled,
            })
            .then(() => onSaved())
            .catch((caught: unknown) => onError(caught instanceof Error ? caught.message : String(caught)));
        }}
      >
        <Field label="Name">
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        {mode === 'routines' ? (
          <Field label="Prompt">
            <textarea value={prompt} rows={4} onChange={(event) => setPrompt(event.target.value)} />
          </Field>
        ) : (
          <Field label="Cron (minute hour day month weekday)">
            <input value={cron} onChange={(event) => setCron(event.target.value)} />
          </Field>
        )}
        {mode === 'routines' ? (
        <div className="row">
          <Field label="Run as">
            <select
              value={targetType}
              onChange={(event) => {
                const next = event.target.value as 'agent' | 'room';
                setTargetType(next);
                if (next === 'room' && !targetId && rooms[0]) setTargetId(rooms[0].id);
              }}
            >
              <option value="agent">This agent</option>
              <option value="room">A group room</option>
            </select>
          </Field>
          {targetType === 'room' ? (
            <Field label="Room">
              <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
        ) : (
          <label className="check">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            Enabled while the app is open
          </label>
        )}
        <div className="row">
          <button className="primary" type="submit">
            {mode === 'cron' ? 'Save schedule' : 'Save routine'}
          </button>
          {selected && mode === 'routines' ? (
            <>
              <button
                type="button"
                onClick={() =>
                  void window.agent
                    .runRoutine(selected)
                    .then(() => window.agent.listRoutineRuns(selected))
                    .then(setRuns)
                    .catch((caught: unknown) => onError(String(caught)))
                }
              >
                Run now
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  void window.agent
                    .deleteRoutine(selected)
                    .then(() => {
                      select(undefined);
                      onSaved();
                    })
                    .catch((caught: unknown) => onError(String(caught)))
                }
              >
                Delete routine
              </button>
            </>
          ) : null}
        </div>
      </form>
      {runs.length > 0 ? (
        <ul className="tools">
          {runs.map((run) => (
            <li key={run.id}>
              {run.status}
              {run.output ? ` — ${run.output.slice(0, 180)}` : ''}
              {run.error ? ` — ${run.error}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
