import type { ChatEvent, ChatMessage, ChatSnapshot } from '@shared/types';

export function applyChatEvent(current: ChatSnapshot | null, event: ChatEvent): ChatSnapshot | null {
  if (!current || !('conversationId' in event) || event.conversationId !== current.conversation.id) return current;
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
          reasoning: '',
          reasoningMs: null,
          phase: 'thinking',
          createdAt: Date.now(),
          tools: [],
          attachments: [],
        },
      ],
    };
  }
  if (event.type === 'assistant-delta' || event.type === 'assistant-reasoning' || event.type === 'assistant-phase' || event.type === 'tool') {
    return {
      ...current,
      messages: current.messages.map((message) => (message.id === event.messageId ? updateMessage(message, event) : message)),
    };
  }
  return current;
}

function updateMessage(message: ChatMessage, event: ChatEvent): ChatMessage {
  if (event.type === 'assistant-delta') return { ...message, content: message.content + event.delta };
  if (event.type === 'assistant-reasoning') return { ...message, reasoning: `${message.reasoning ?? ''}${event.delta}` };
  if (event.type === 'assistant-phase') return { ...message, phase: event.phase, reasoningMs: event.elapsedMs };
  if (event.type === 'tool') {
    return { ...message, tools: [...message.tools.filter((tool) => tool.id !== event.tool.id), event.tool] };
  }
  return message;
}
