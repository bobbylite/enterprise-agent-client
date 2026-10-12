import { parseOpenAiData, readSse } from './sse';
import { schemaOf, type ChatProvider, type ProviderMessage, type ProviderToolCall } from './types';

export function createOpenAiProvider(fetchImpl: typeof fetch = fetch): ChatProvider {
  return {
    id: 'openai',
    async stream(request, onDelta, signal) {
      if (!request.apiKey) throw new Error('Add an OpenAI-compatible API key in Settings.');
      const base = (request.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
      const response = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${request.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          temperature: request.temperature,
          stream: true,
          messages: [
            { role: 'system', content: request.system },
            ...request.messages.map(toOpenAiMessage),
          ],
          tools: request.tools.length
            ? request.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description ?? '',
                  parameters: schemaOf(tool),
                },
              }))
            : undefined,
        }),
      });
      if (!response.ok) {
        throw new Error(await errorText(response, 'The model provider rejected the request'));
      }
      let content = '';
      const calls = new Map<number, ProviderToolCall>();
      await readSse(response, (data) => {
        const parsed = parseOpenAiData(data);
        if (!parsed || parsed === 'done') return;
        if (parsed.text) {
          content += parsed.text;
          onDelta(parsed.text);
        }
        for (const call of parsed.toolCalls) {
          const current = calls.get(call.index) ?? { id: '', name: '', arguments: '' };
          if (call.id) current.id = call.id;
          if (call.name) current.name = call.name;
          if (call.arguments) current.arguments += call.arguments;
          calls.set(call.index, current);
        }
      });
      return { content, toolCalls: [...calls.values()].filter((call) => call.name) };
    },
  };
}

function toOpenAiMessage(message: ProviderMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  if (message.role === 'user' && message.attachments?.some((item) => item.mime.startsWith('image/') && item.dataBase64)) {
    const content: unknown[] = [{ type: 'text', text: message.content }];
    for (const attachment of message.attachments ?? []) {
      if (attachment.mime.startsWith('image/') && attachment.dataBase64) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${attachment.mime};base64,${attachment.dataBase64}` },
        });
      }
    }
    return { role: 'user', content };
  }
  return { role: message.role, content: message.content };
}

async function errorText(response: Response, fallback: string): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch {
    // The body was not JSON.
  }
  return text || `${fallback} (${response.status}).`;
}
