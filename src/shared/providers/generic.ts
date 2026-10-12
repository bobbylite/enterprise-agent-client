import { readSse } from './sse';
import type { ChatProvider, ProviderToolCall } from './types';

/**
 * Generic HTTP provider.
 * POST {baseUrl} with JSON { model, system, messages, tools, temperature }.
 * Accepts either a JSON body { content, tool_calls } or SSE lines
 * `data: {"delta":"..."}` and `data: {"tool_calls":[...]}`.
 */
export function createGenericProvider(fetchImpl: typeof fetch = fetch): ChatProvider {
  return {
    id: 'generic',
    async stream(request, onDelta, signal) {
      if (!request.baseUrl) throw new Error('Set the generic provider URL in Settings.');
      const response = await fetchImpl(request.baseUrl, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: request.model,
          system: request.system,
          messages: request.messages,
          tools: request.tools,
          temperature: request.temperature,
        }),
      });
      if (!response.ok) {
        throw new Error((await response.text()) || `Generic provider rejected the request (${response.status}).`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        const body = (await response.json()) as { content?: string; tool_calls?: ProviderToolCall[] };
        const content = body.content ?? '';
        if (content) onDelta(content);
        return { content, toolCalls: body.tool_calls ?? [] };
      }
      let content = '';
      const toolCalls: ProviderToolCall[] = [];
      await readSse(response, (data) => {
        if (data === '[DONE]') return;
        const parsed = JSON.parse(data) as { delta?: string; tool_calls?: ProviderToolCall[] };
        if (parsed.delta) {
          content += parsed.delta;
          onDelta(parsed.delta);
        }
        if (parsed.tool_calls) toolCalls.push(...parsed.tool_calls);
      });
      return { content, toolCalls };
    },
  };
}
