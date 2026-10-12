import { useEffect, useState } from 'react';
import type { McpServerInput, McpServerView } from '@shared/types';
import { Field } from '../components/Markdown';

const EMPTY: McpServerInput = {
  name: '',
  transport: 'stdio',
  command: 'node',
  args: '',
  url: '',
  audience: '',
  scope: '',
  enabled: true,
};

export function McpScreen() {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [form, setForm] = useState<McpServerInput>(EMPTY);
  const [error, setError] = useState('');

  async function load(): Promise<void> {
    setServers(await window.agent.listMcpServers());
  }

  useEffect(() => {
    void load().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, []);

  return (
    <div className="page">
      <header className="pane-head">
        <h2>Tools</h2>
        <p>Connect stdio, streamable HTTP, or SSE MCP servers. HTTP calls receive the audience token from token exchange.</p>
      </header>
      {error ? <p className="error">{error}</p> : null}
      <div className="cards">
        {servers.map((server) => (
          <article key={server.id} className="card">
            <header>
              <h3>{server.name}</h3>
              <span className={`status ${server.status}`}>{server.status}</span>
            </header>
            <p className="muted">
              {server.transport}
              {server.audience ? ` · ${server.audience}` : ''}
            </p>
            {server.error ? <p className="error">{server.error}</p> : null}
            {server.tools.length > 0 ? (
              <ul className="tools">
                {server.tools.map((tool) => (
                  <li key={tool.name}>
                    <strong>{tool.name}</strong>
                    {tool.readOnlyHint ? <span>read-only</span> : null}
                    <p>{tool.description}</p>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="row">
              {server.status === 'connected' ? (
                <button type="button" onClick={() => void window.agent.disconnectMcp(server.id).then(load)}>
                  Disconnect
                </button>
              ) : (
                <button type="button" className="primary" onClick={() => void window.agent.connectMcp(server.id).then(load).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))}>
                  Connect
                </button>
              )}
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  setForm({
                    id: server.id,
                    name: server.name,
                    transport: server.transport,
                    command: server.command,
                    args: server.args.join('\n'),
                    url: server.url,
                    audience: server.audience,
                    scope: server.scope,
                    enabled: server.enabled,
                  })
                }
              >
                Edit
              </button>
              <button type="button" className="ghost" onClick={() => void window.agent.deleteMcpServer(server.id).then(load)}>
                Remove
              </button>
            </div>
          </article>
        ))}
      </div>
      <form
        className="stack card"
        onSubmit={(event) => {
          event.preventDefault();
          void window.agent
            .saveMcpServer(form)
            .then(() => {
              setForm(EMPTY);
              return load();
            })
            .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
        }}
      >
        <h3>{form.id ? 'Edit server' : 'Add server'}</h3>
        <Field label="Name">
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <Field label="Transport">
          <select value={form.transport} onChange={(event) => setForm({ ...form, transport: event.target.value as McpServerInput['transport'] })}>
            <option value="stdio">stdio</option>
            <option value="http">streamable HTTP</option>
            <option value="sse">SSE</option>
          </select>
        </Field>
        {form.transport === 'stdio' ? (
          <>
            <Field label="Command">
              <input value={form.command} onChange={(event) => setForm({ ...form, command: event.target.value })} />
            </Field>
            <Field label="Arguments (one per line)">
              <textarea value={form.args} rows={3} onChange={(event) => setForm({ ...form, args: event.target.value })} />
            </Field>
          </>
        ) : (
          <Field label="URL">
            <input value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} />
          </Field>
        )}
        <Field label="Token audience">
          <input value={form.audience} onChange={(event) => setForm({ ...form, audience: event.target.value })} />
        </Field>
        <Field label="Scope">
          <input value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value })} />
        </Field>
        <button className="primary" type="submit">
          Save server
        </button>
      </form>
    </div>
  );
}
