import { useEffect, useState } from 'react';
import type { ChatMessage, ToolInvocation } from '@shared/types';
import { Markdown } from './Markdown';

export function Transcript({ messages, showReasoning }: { messages: ChatMessage[]; showReasoning: boolean }) {
  return (
    <div className="transcript">
      {messages.map((message) => (
        <article key={message.id} className={`bubble ${message.role}`}>
          <header>{message.authorName || message.role}</header>
          {showReasoning ? <ThinkingPanel message={message} /> : null}
          {message.content ? <Markdown text={message.content} /> : null}
          {message.phase === 'cancelled' ? <p className="muted">Stopped. The partial answer is kept.</p> : null}
          {message.attachments.length > 0 ? (
            <ul className="chips">
              {message.attachments.map((attachment) => (
                <li key={attachment.id}>
                  {attachment.name}
                  <span>{Math.ceil(attachment.size / 1024)} KB</span>
                </li>
              ))}
            </ul>
          ) : null}
          {message.tools.map((tool) => (
            <div key={tool.id} className={`tool-card ${tool.status}`}>
              <header>
                <strong>{toolStatusLabel(tool)}</strong>
                <span>{tool.serverName}</span>
              </header>
              {tool.status === 'done' || tool.status === 'denied' || tool.status === 'error' ? (
                <pre>{JSON.stringify(tool.args, null, 2)}</pre>
              ) : null}
              {tool.result ? <p>{tool.result}</p> : null}
            </div>
          ))}
        </article>
      ))}
    </div>
  );
}

function ThinkingPanel({ message }: { message: ChatMessage }) {
  const thinking = message.phase === 'thinking';
  const [open, setOpen] = useState(thinking);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!thinking) {
      setOpen(false);
      return;
    }
    setOpen(true);
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [thinking, message.id]);
  const hasTrace = Boolean(message.reasoning) || message.phase === 'thinking' || message.phase === 'answering' || message.reasoningMs != null;
  if (!hasTrace) return null;
  const elapsed = thinking ? Math.max(0, now - message.createdAt) : (message.reasoningMs ?? 0);
  return (
    <div className="thinking">
      <button type="button" className="ghost" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? 'Hide thinking' : 'Thinking'} · {formatElapsed(elapsed)}
      </button>
      {open ? <p>{message.reasoning?.trim() ? message.reasoning : 'Thinking…'}</p> : null}
    </div>
  );
}

function toolStatusLabel(tool: ToolInvocation): string {
  if (tool.status === 'calling') return `Calling ${tool.toolName}…`;
  if (tool.status === 'approval') return `Waiting for approval to run ${tool.toolName}…`;
  if (tool.status === 'running') return `Running ${tool.toolName}…`;
  return tool.toolName;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}
