import type { ChatMessage } from '@shared/types';
import { Markdown } from './Markdown';

export function Transcript({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="transcript">
      {messages.map((message) => (
        <article key={message.id} className={`bubble ${message.role}`}>
          <header>{message.authorName || message.role}</header>
          {message.content ? <Markdown text={message.content} /> : null}
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
                <strong>{tool.toolName}</strong>
                <span>
                  {tool.serverName} · {tool.status}
                  {tool.approval ? ` · ${tool.approval}` : ''}
                </span>
              </header>
              <pre>{JSON.stringify(tool.args, null, 2)}</pre>
              {tool.result ? <p>{tool.result}</p> : null}
            </div>
          ))}
        </article>
      ))}
    </div>
  );
}
