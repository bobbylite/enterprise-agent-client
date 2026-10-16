import { useEffect, useRef, useState } from 'react';
import type { Attachment, Branding, ChatEvent, ChatSnapshot, Conversation } from '@shared/types';
import { applyChatEvent } from '../chat-events';
import { Transcript } from '../components/Transcript';

export function ChatScreen({
  branding,
  showReasoning,
  chatMode,
}: {
  branding: Branding;
  showReasoning: boolean;
  chatMode: 'allow' | 'read_only' | 'locked';
}) {
  const composerLocked = chatMode !== 'allow';
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
      setSnapshot((current) => applyChatEvent(current, event));
    });
  }, []);

  async function removeChat(id: string): Promise<void> {
    if (!window.confirm('Delete this chat? Its messages, attachments, and tool results will be removed from this device.')) return;
    const wasOpen = activeId.current === id;
    await window.agent.deleteConversation(id);
    if (wasOpen) {
      const created = await window.agent.createConversation();
      await refreshList(created.conversation.id);
      return;
    }
    await refreshList();
  }

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
          <div key={conversation.id} className="list-row">
            <button
              type="button"
              className={conversation.id === snapshot?.conversation.id ? 'list-item selected' : 'list-item'}
              onClick={() => void refreshList(conversation.id)}
            >
              {conversation.title}
            </button>
            <button type="button" className="ghost danger-text" aria-label={`Delete ${conversation.title}`} onClick={() => void removeChat(conversation.id)}>
              Delete
            </button>
          </div>
        ))}
      </div>
      <div className="conversation">
        {snapshot ? (
          <>
            <header className="pane-head">
              <div className="row">
                <h2>{snapshot.conversation.title}</h2>
                <button type="button" className="ghost danger-text" onClick={() => void removeChat(snapshot.conversation.id)}>
                  Delete chat
                </button>
              </div>
              <p>Talking with {branding.agentName}</p>
            </header>
            {snapshot.messages.length === 0 ? (
              <div className="empty">
                <h3>Start a conversation</h3>
                <p>Messages stream here. Try “echo hello” after connecting the local echo tool.</p>
              </div>
            ) : (
              <Transcript messages={snapshot.messages} showReasoning={showReasoning} resetKey={snapshot.conversation.id} />
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
                if (composerLocked) return;
                void send();
              }}
            >
              <textarea
                value={draft}
                placeholder={
                  chatMode === 'locked'
                    ? 'Chat is locked because Protect scored this session HIGH.'
                    : chatMode === 'read_only'
                      ? 'Chat is read-only for this session'
                      : `Message ${branding.agentName}`
                }
                disabled={composerLocked}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    if (!composerLocked) void send();
                  }
                }}
              />
              <div className="row">
                <button
                  type="button"
                  className="ghost"
                  disabled={composerLocked}
                  onClick={() => void window.agent.pickAttachments().then((picked) => setAttachments((current) => [...current, ...picked]))}
                >
                  Attach
                </button>
                {busy ? (
                  <button
                    className="primary"
                    type="button"
                    onClick={() => void window.agent.stopGeneration(snapshot.conversation.id)}
                  >
                    Stop
                  </button>
                ) : (
                  <button className="primary" type="submit" disabled={composerLocked}>
                    Send
                  </button>
                )}
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
