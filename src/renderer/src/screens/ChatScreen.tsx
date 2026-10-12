import { useEffect, useRef, useState } from 'react';
import type { Attachment, Branding, ChatEvent, ChatSnapshot, Conversation } from '@shared/types';
import { Transcript } from '../components/Transcript';

export function ChatScreen({ branding }: { branding: Branding }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const activeId = useRef('');

  async function refreshList(selectId?: string): Promise<void> {
    const list = await window.agent.listConversations();
    setConversations(list);
    const id = selectId || activeId.current || list[0]?.id;
    if (!id) {
      setSnapshot(null);
      return;
    }
    const opened = await window.agent.openConversation(id);
    activeId.current = opened.conversation.id;
    setSnapshot(opened);
  }

  useEffect(() => {
    void refreshList().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    return window.agent.onChatEvent((event: ChatEvent) => {
      if (event.type === 'error' && event.conversationId === activeId.current) setError(event.message);
      if (!('conversationId' in event) || event.conversationId !== activeId.current) return;
      setSnapshot((current) => applyEvent(current, event));
    });
  }, []);

  async function send(): Promise<void> {
    if (!snapshot) return;
    setBusy(true);
    setError('');
    const text = draft;
    const ids = attachments.map((item) => item.id);
    setDraft('');
    setAttachments([]);
    try {
      await window.agent.sendMessage(snapshot.conversation.id, text, ids);
      await refreshList(snapshot.conversation.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      await refreshList(snapshot.conversation.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="split">
      <div className="list-pane">
        <button
          type="button"
          className="primary"
          onClick={() => void window.agent.createConversation().then((created) => refreshList(created.conversation.id))}
        >
          New chat
        </button>
        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            className={conversation.id === snapshot?.conversation.id ? 'list-item selected' : 'list-item'}
            onClick={() => void refreshList(conversation.id)}
          >
            {conversation.title}
          </button>
        ))}
      </div>
      <div className="conversation">
        {snapshot ? (
          <>
            <header className="pane-head">
              <h2>{snapshot.conversation.title}</h2>
              <p>Talking with {branding.agentName}</p>
            </header>
            {snapshot.messages.length === 0 ? (
              <div className="empty">
                <h3>Start a conversation</h3>
                <p>Messages stream here. Try “echo hello” after connecting the local echo tool.</p>
              </div>
            ) : (
              <Transcript messages={snapshot.messages} />
            )}
            {error ? <p className="error">{error}</p> : null}
            {attachments.length > 0 ? (
              <ul className="chips">
                {attachments.map((attachment) => (
                  <li key={attachment.id}>{attachment.name}</li>
                ))}
              </ul>
            ) : null}
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <textarea
                value={draft}
                placeholder={`Message ${branding.agentName}`}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="row">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void window.agent.pickAttachments().then((picked) => setAttachments((current) => [...current, ...picked]))}
                >
                  Attach
                </button>
                <button className="primary" type="submit" disabled={busy}>
                  {busy ? 'Working' : 'Send'}
                </button>
              </div>
            </form>
          </>
        ) : (
          <div className="empty">
            <h3>No conversations yet</h3>
            <p>Create one to talk with {branding.agentName}.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function applyEvent(current: ChatSnapshot | null, event: ChatEvent): ChatSnapshot | null {
  if (!current) return current;
  if (event.type === 'assistant-start') {
    return {
      ...current,
      messages: [
        ...current.messages,
        {
          id: event.messageId,
          conversationId: event.conversationId,
          role: 'assistant',
          authorId: event.authorId,
          authorName: event.authorName,
          content: '',
          createdAt: Date.now(),
          tools: [],
          attachments: [],
        },
      ],
    };
  }
  if (event.type === 'assistant-delta') {
    return {
      ...current,
      messages: current.messages.map((message) =>
        message.id === event.messageId ? { ...message, content: message.content + event.delta } : message,
      ),
    };
  }
  if (event.type === 'tool') {
    return {
      ...current,
      messages: current.messages.map((message) =>
        message.id === event.messageId
          ? { ...message, tools: [...message.tools.filter((tool) => tool.id !== event.tool.id), event.tool] }
          : message,
      ),
    };
  }
  return current;
}
