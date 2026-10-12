import { parseAnthropicData, readSse } from './sse';
import { schemaOf, type ChatProvider, type ProviderMessage, type ProviderToolCall } from './types';

export function createAnthropicProvider(fetchImpl: typeof fetch = fetch): ChatProvider {
  return {
    id: 'anthropic',
    async stream(request, onDelta, signal) {
      if (!request.apiKey) throw new Error('Add an Anthropic API key in Settings.');
      const base = (request.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
      const response = await fetchImpl(`${base}/v1/messages`, {
        method: 'POST',
        signal,
        headers: {
          'x-api-key': request.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: 4096,
          temperature: request.temperature,
          stream: true,
          system: request.system,
          messages: toAnthropicMessages(request.messages),
          tools: request.tools.length
            ? request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description ?? '',
                input_schema: schemaOf(tool),
              }))
            : undefined,
        }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Anthropic rejected the request (${response.status}).`);
      }
      let content = '';
      const calls = new Map<number, ProviderToolCall>();
      await readSse(response, (data) => {
        const parsed = parseAnthropicData(data);
        if (!parsed) return;
        if (parsed.text) {
          content += parsed.text;
          onDelta(parsed.text);
        }
        if (parsed.tool) {
          const current = calls.get(parsed.tool.index) ?? { id: '', name: '', arguments: '' };
          if (parsed.tool.id) current.id = parsed.tool.id;
          if (parsed.tool.name) current.name = parsed.tool.name;
          if (parsed.tool.partialJson) current.arguments += parsed.tool.partialJson;
          calls.set(parsed.tool.index, current);
        }
      });
      return { content, toolCalls: [...calls.values()].filter((call) => call.name) };
    },
  };
}

function toAnthropicMessages(messages: ProviderMessage[]): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      output.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: message.content,
          },
        ],
      });
      continue;
    }
    if (message.role === 'assistant') {
      const content: unknown[] = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        let input: unknown;
        try {
          input = JSON.parse(call.arguments);
        } catch {
          input = { raw: call.arguments };
        }
        content.push({ type: 'tool_use', id: call.id, name: call.name, input });
      }
      output.push({ role: 'assistant', content: content.length > 0 ? content : message.content });
      continue;
    }
    const blocks: unknown[] = [{ type: 'text', text: message.content }];
    for (const attachment of message.attachments ?? []) {
      if (attachment.mime.startsWith('image/') && attachment.dataBase64) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: attachment.mime, data: attachment.dataBase64 },
        });
      }
    }
    output.push({ role: 'user', content: blocks });
  }
  return output;
}
