import { useEffect, useState } from 'react';
import { joinCommandLine } from '@shared/mcp/command';
import type { McpExtensionType, McpHeader, McpServerView } from '@shared/types';
import { Field } from '../components/Markdown';

interface Pair {
  name: string;
  value: string;
}

interface DialogState {
  id?: string;
  name: string;
  type: McpExtensionType;
  description: string;
  command: string;
  url: string;
  timeout: string;
  headers: McpHeader[];
  env: Pair[];
  enabled: boolean;
}

const EMPTY: DialogState = {
  name: '',
  type: 'streamable_http',
  description: '',
  command: '',
  url: '',
  timeout: '300',
  headers: [],
  env: [],
  enabled: true,
};

export function McpScreen() {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [error, setError] = useState('');

  async function load(): Promise<void> {
    setServers(await window.agent.listMcpServers());
  }

  useEffect(() => {
    void load().catch((caught: unknown) => setError(messageOf(caught)));
  }, []);

  return (
    <div className="page">
      <header className="pane-head extension-page-head">
        <div>
          <h2>Extensions</h2>
          <p>Custom MCP extensions. HTTP servers sign in with MCP authorization unless an audience is already configured.</p>
        </div>
        <button type="button" className="primary" onClick={() => setDialog(EMPTY)}>
          + Add custom extension
        </button>
      </header>
      {error ? <p className="error">{error}</p> : null}
      <div className="cards">
        {servers.map((server) => (
          <ExtensionCard
            key={server.id}
            server={server}
            onError={setError}
            onEdit={() => setDialog(dialogFrom(server))}
            onChange={() => void load().catch((caught: unknown) => setError(messageOf(caught)))}
          />
        ))}
      </div>
      {dialog ? (
        <ExtensionDialog
          initial={dialog}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            setError('');
            void load().catch((caught: unknown) => setError(messageOf(caught)));
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function ExtensionCard({
  server,
  onError,
  onEdit,
  onChange,
}: {
  server: McpServerView;
  onError: (message: string) => void;
  onEdit: () => void;
  onChange: () => void;
}) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const statusLabel = !server.enabled
    ? 'Disabled'
    : server.needsSignIn
      ? 'Needs sign-in'
      : server.status === 'connected'
        ? 'Connected'
        : server.status === 'error'
          ? 'Error'
          : 'Disconnected';

  async function run(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      onError('');
      onChange();
    } catch (caught) {
      onError(messageOf(caught));
      onChange();
    }
  }

  return (
    <article className="card extension-card">
      <header>
        <h3>{server.name}</h3>
        <label className="switch">
          <input
            type="checkbox"
            checked={server.enabled}
            aria-label={`Enable ${server.name}`}
            onChange={(event) => void run(() => window.agent.setMcpEnabled(server.id, event.target.checked))}
          />
          <span />
        </label>
      </header>
      <p className="muted">
        {typeLabel(server.type)}
        {server.description ? ` · ${server.description}` : ''}
      </p>
      <span className={`status ${server.needsSignIn ? 'needs-sign-in' : server.status}`}>{statusLabel}</span>
      {server.authKind === 'worker' ? <p className="muted">Worker token</p> : null}
      {server.authKind === 'exchange' ? <p className="muted">Token exchange</p> : null}
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
      {server.needsClient ? (
        <div className="stack">
          <Field label="Client ID">
            <input value={clientId} onChange={(event) => setClientId(event.target.value)} />
          </Field>
          <Field label="Client secret">
            <input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} />
          </Field>
        </div>
      ) : null}
      <div className="row">
        {server.authKind === 'oauth' && server.needsSignIn ? (
          <button
            type="button"
            className="primary"
            onClick={() =>
              void run(() =>
                window.agent.signInMcp(server.id, server.needsClient ? { clientId, clientSecret } : undefined),
              )
            }
          >
            Sign in
          </button>
        ) : null}
        {server.authKind === 'oauth' && server.signedIn ? (
          <button type="button" className="ghost" onClick={() => void run(() => window.agent.signOutMcp(server.id))}>
            Sign out
          </button>
        ) : null}
        {server.status === 'connected' ? (
          <button type="button" className="ghost" onClick={() => void run(() => window.agent.disconnectMcp(server.id))}>
            Disconnect
          </button>
        ) : server.enabled && !server.needsSignIn ? (
          <button type="button" className="primary" onClick={() => void run(() => window.agent.connectMcp(server.id))}>
            Connect
          </button>
        ) : null}
        <button type="button" className="ghost" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="ghost" onClick={() => void run(() => window.agent.deleteMcpServer(server.id))}>
          Delete
        </button>
      </div>
      {server.authKind === 'oauth' && server.oauthSteps.length > 0 ? (
        <details className="oauth-debug">
          <summary>Authorization debug</summary>
          <ol>
            {server.oauthSteps.map((step, index) => (
              <li key={`${step.kind}-${index}`} className={step.ok ? 'oauth-step' : 'oauth-step bad'}>
                <strong>{step.title}</strong>
                <p>{step.detail}</p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </article>
  );
}

function ExtensionDialog({
  initial,
  onClose,
  onSaved,
  onError,
}: {
  initial: DialogState;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState(initial);
  const [headerName, setHeaderName] = useState('');
  const [headerValue, setHeaderValue] = useState('');
  const [envName, setEnvName] = useState('');
  const [envValue, setEnvValue] = useState('');
  const http = form.type === 'streamable_http' || form.type === 'sse';
  const valid = dialogValid(form);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function addHeader(): void {
    if (!headerName.trim() || !headerValue) return;
    setForm({ ...form, headers: [...form.headers, { name: headerName.trim(), value: headerValue }] });
    setHeaderName('');
    setHeaderValue('');
  }

  function addEnv(): void {
    if (!envName.trim() || !envValue) return;
    setForm({ ...form, env: [...form.env, { name: envName.trim(), value: envValue }] });
    setEnvName('');
    setEnvValue('');
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal extension-dialog"
        aria-label={form.id ? 'Edit extension' : 'Add custom extension'}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          const timeout = Number(form.timeout);
          void window.agent
            .saveMcpServer({
              id: form.id,
              name: form.name,
              type: form.type,
              description: form.description,
              command: http ? '' : form.command,
              args: '',
              url: http ? form.url : '',
              headers: http ? form.headers : [],
              env: http ? undefined : form.env,
              timeout,
              enabled: form.enabled,
            })
            .then(onSaved)
            .catch((caught: unknown) => onError(messageOf(caught)));
        }}
      >
        <header className="extension-title">
          <h3>{form.id ? 'Edit extension' : '+ Add custom extension'}</h3>
          <button type="button" className="ghost icon-button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="extension-row">
          <Field label="Extension Name">
            <input
              placeholder="Enter extension name..."
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label="Type">
            <select
              value={form.type === 'builtin' ? 'stdio' : form.type}
              onChange={(event) => setForm({ ...form, type: event.target.value as McpExtensionType })}
            >
              <option value="streamable_http">HTTP</option>
              <option value="stdio">STDIO</option>
              <option value="sse">SSE</option>
            </select>
          </Field>
        </div>
        <Field label="Description">
          <input
            placeholder="Optional description..."
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
        </Field>
        <hr />
        {http ? (
          <>
            <Field label="Endpoint">
              <input
                placeholder="Enter endpoint URL..."
                value={form.url}
                onChange={(event) => setForm({ ...form, url: event.target.value })}
              />
            </Field>
            <Field label="Timeout">
              <input value={form.timeout} onChange={(event) => setForm({ ...form, timeout: event.target.value })} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Command">
              <input
                placeholder="Command and arguments"
                value={form.command}
                onChange={(event) => setForm({ ...form, command: event.target.value })}
              />
            </Field>
            <Field label="Timeout">
              <input value={form.timeout} onChange={(event) => setForm({ ...form, timeout: event.target.value })} />
            </Field>
            <div className="stack">
              <strong>Environment Variables</strong>
              <p className="muted">Values are stored in the OS keychain and are never written to enterprise.json. Leave a value blank to keep the saved secret.</p>
              <div className="extension-add">
                <input placeholder="Name" value={envName} onChange={(event) => setEnvName(event.target.value)} />
                <input placeholder="Value" type="password" value={envValue} onChange={(event) => setEnvValue(event.target.value)} />
                <button type="button" className="ghost" disabled={!envName.trim() || !envValue} onClick={addEnv}>
                  + Add
                </button>
              </div>
              {form.env.length > 0 ? (
                <ul className="kv-list">
                  {form.env.map((entry) => (
                    <li key={entry.name}>
                      <span>{entry.name}</span>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setForm({ ...form, env: form.env.filter((item) => item.name !== entry.name) })}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </>
        )}
        {http ? (
          <>
            <hr />
            <div className="stack">
              <strong>Request Headers</strong>
              <p className="muted">
                Add custom HTTP headers to include in requests to the MCP server. Click the "+" button to add after filling both fields.
              </p>
              <div className="extension-add">
                <input placeholder="Header name" value={headerName} onChange={(event) => setHeaderName(event.target.value)} />
                <input placeholder="Value" value={headerValue} onChange={(event) => setHeaderValue(event.target.value)} />
                <button type="button" className="ghost" disabled={!headerName.trim() || !headerValue} onClick={addHeader}>
                  + Add
                </button>
              </div>
              {form.headers.length > 0 ? (
                <ul className="kv-list">
                  {form.headers.map((header) => (
                    <li key={header.name}>
                      <span>
                        {header.name}: {header.value}
                      </span>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setForm({ ...form, headers: form.headers.filter((item) => item.name !== header.name) })}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </>
        ) : null}
        <footer className="extension-footer">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            {form.id ? 'Save' : 'Add Extension'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function dialogFrom(server: McpServerView): DialogState {
  return {
    id: server.id,
    name: server.name,
    type: server.type,
    description: server.description,
    command: joinCommandLine(server.command, server.args),
    url: server.url,
    timeout: String(server.timeout || 300),
    headers: server.headers,
    env: server.envKeys.map((name) => ({ name, value: '' })),
    enabled: server.enabled,
  };
}

function dialogValid(form: DialogState): boolean {
  if (!form.name.trim()) return false;
  const timeout = Number(form.timeout);
  if (!Number.isInteger(timeout) || timeout < 1) return false;
  if (form.type === 'stdio') return form.command.trim().length > 0;
  return isHttpUrl(form.url);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function typeLabel(type: McpExtensionType): string {
  if (type === 'streamable_http') return 'HTTP';
  if (type === 'stdio') return 'STDIO';
  if (type === 'sse') return 'SSE';
  return 'Built-in';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
