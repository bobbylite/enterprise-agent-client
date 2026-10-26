import { useEffect, useState } from 'react';
import type { AppState, ProviderId, SettingsView } from '@shared/types';
import { Field } from '../components/Markdown';
import { TokenInspector } from './TokenInspector';

export function SettingsScreen({ state }: { state: AppState }) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [genericApiKey, setGenericApiKey] = useState('');
  const [workerClientSecret, setWorkerClientSecret] = useState('');
  const [agentClientSecret, setAgentClientSecret] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    void window.agent.getSettings().then(setSettings);
  }, []);

  if (!settings) return <div className="page">Loading</div>;

  return (
    <div className="page narrow">
      <header className="pane-head">
        <h2>Settings</h2>
        <p>
          Mode: {state.mode}. Keys are stored in the OS keychain when encryption is available
          {state.encryptionAvailable ? '' : ' — encryption is not available, so secrets stay in memory for this launch only'}.
        </p>
      </header>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void window.agent
            .saveSettings({
              ...settings,
              openaiApiKey: openaiApiKey || undefined,
              anthropicApiKey: anthropicApiKey || undefined,
              genericApiKey: genericApiKey || undefined,
              workerClientSecret: workerClientSecret || undefined,
              agentClientSecret: agentClientSecret || undefined,
            })
            .then((saved) => {
              setSettings(saved);
              setOpenaiApiKey('');
              setAnthropicApiKey('');
              setGenericApiKey('');
              setWorkerClientSecret('');
              setAgentClientSecret('');
              setMessage('Saved.');
            })
            .catch((caught: unknown) => setMessage(caught instanceof Error ? caught.message : String(caught)));
        }}
      >
        <Field label="Model provider">
          <select
            value={settings.provider}
            onChange={(event) => setSettings({ ...settings, provider: event.target.value as ProviderId })}
          >
            <option value="mock">Mock (no network)</option>
            <option value="openai">OpenAI-compatible</option>
            <option value="anthropic">Anthropic</option>
            <option value="generic">Generic HTTP</option>
          </select>
        </Field>
        <Field label="Model">
          <input value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} />
        </Field>
        <Field label="Temperature">
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={settings.temperature ?? ''}
            placeholder="Model default"
            onChange={(event) => {
              const raw = event.target.value;
              setSettings({ ...settings, temperature: raw === '' ? null : Number(raw) });
            }}
          />
        </Field>
        <p className="muted">Leave blank to omit temperature. gpt-5 and o-series models do not accept it.</p>
        <Field label="OpenAI-compatible base URL">
          <input value={settings.openaiBaseUrl} onChange={(event) => setSettings({ ...settings, openaiBaseUrl: event.target.value })} />
        </Field>
        <Field label={`OpenAI API key ${settings.keys.openai ? '(stored)' : '(not set)'}`}>
          <input type="password" value={openaiApiKey} placeholder="Leave blank to keep the stored key" onChange={(event) => setOpenaiApiKey(event.target.value)} />
        </Field>
        <Field label="Anthropic base URL">
          <input value={settings.anthropicBaseUrl} onChange={(event) => setSettings({ ...settings, anthropicBaseUrl: event.target.value })} />
        </Field>
        <Field label={`Anthropic API key ${settings.keys.anthropic ? '(stored)' : '(not set)'}`}>
          <input type="password" value={anthropicApiKey} placeholder="Leave blank to keep the stored key" onChange={(event) => setAnthropicApiKey(event.target.value)} />
        </Field>
        <Field label="Generic provider URL">
          <input value={settings.genericBaseUrl} onChange={(event) => setSettings({ ...settings, genericBaseUrl: event.target.value })} />
        </Field>
        <Field label={`Generic API key ${settings.keys.generic ? '(stored)' : '(not set)'}`}>
          <input type="password" value={genericApiKey} placeholder="Leave blank to keep the stored key" onChange={(event) => setGenericApiKey(event.target.value)} />
        </Field>
        <Field label={`Worker client secret ${settings.keys.worker ? '(stored)' : '(not set)'}`}>
          <input type="password" value={workerClientSecret} placeholder="PingOne Protect only" onChange={(event) => setWorkerClientSecret(event.target.value)} />
        </Field>
        <Field label={`AI Agent client secret ${settings.keys.agent ? '(stored)' : '(not set)'}`}>
          <input type="password" value={agentClientSecret} placeholder="Token exchange (PINGONE_AGENT_CLIENT_SECRET)" onChange={(event) => setAgentClientSecret(event.target.value)} />
        </Field>
        <p className="muted">
          Protect uses the worker secret. Token exchange uses the AI Agent secret. If that secret is empty, exchange falls back to the worker. User SSO introspection sends tenant.clientId as client_id and does not use a secret.
        </p>
        {message ? <p className="notice">{message}</p> : null}
        <button className="primary" type="submit">
          Save settings
        </button>
      </form>
      {settings.tokenInspector ? <TokenInspector session={state.session} /> : null}
    </div>
  );
}
