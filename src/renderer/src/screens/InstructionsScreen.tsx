import { useEffect, useState, type ReactNode } from 'react';
import type { InstructionEditorState, InstructionFields } from '@shared/types';
import { Field } from '../components/Markdown';

const FIELDS: { key: keyof InstructionFields; label: string }[] = [
  { key: 'persona', label: 'Persona' },
  { key: 'communicationStyle', label: 'Communication style' },
  { key: 'autonomy', label: 'Autonomy and approvals' },
  { key: 'safety', label: 'Safety' },
  { key: 'untrustedContent', label: 'Untrusted content' },
];

export function InstructionsScreen() {
  const [editor, setEditor] = useState<InstructionEditorState | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void window.agent.getInstructions().then(setEditor).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, []);

  if (!editor) return <div className="page">{error || 'Loading'}</div>;

  return (
    <div className="page">
      <header className="pane-head">
        <h2>Instructions</h2>
        <p>Enterprise policy is locked. The agent persona and your preferences layer underneath it. Risk context is added automatically on each turn.</p>
      </header>
      {error ? <p className="error">{error}</p> : null}
      <section className="stack card locked">
        <h3>Enterprise policy</h3>
        <p className="muted">Locked by admin config. It overrides the layers below.</p>
        {FIELDS.map((field) => (
          <Field key={field.key} label={field.label}>
            <textarea value={editor.enterprise[field.key]} readOnly rows={3} />
          </Field>
        ))}
      </section>
      <Layer
        title="Agent persona"
        fields={editor.persona}
        onChange={(persona) => setEditor({ ...editor, persona })}
        onSave={() => void window.agent.savePersona(editor.persona).then(setEditor).catch((caught: unknown) => setError(String(caught)))}
        extra={
          <button type="button" className="ghost" onClick={() => void window.agent.resetPersona().then(setEditor)}>
            Reset to branding default
          </button>
        }
      />
      <Layer
        title="Your preferences"
        fields={editor.user}
        onChange={(user) => setEditor({ ...editor, user })}
        onSave={() => void window.agent.saveUserLayer(editor.user).then(setEditor).catch((caught: unknown) => setError(String(caught)))}
      />
    </div>
  );
}

function Layer({
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
          <textarea
            rows={3}
            value={fields[field.key]}
            onChange={(event) => onChange({ ...fields, [field.key]: event.target.value })}
          />
        </Field>
      ))}
      <div className="row">
        <button type="button" className="primary" onClick={onSave}>
          Save
        </button>
        {extra}
      </div>
    </section>
  );
}
