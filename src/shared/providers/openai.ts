import { parseOpenAiData, readSse } from './sse';
import {
  isCancellation,
  schemaOf,
  StreamCancelled,
  type ChatProvider,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderToolCall,
} from './types';

export const REASONING_MAX_COMPLETION_TOKENS = 4096;

const SAMPLING_PARAMETERS = new Set([
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'reasoning_effort',
  'frequency_penalty',
  'presence_penalty',
  'logprobs',
  'n',
]);

export function isReasoningModel(model: string): boolean {
  const name = model.trim().toLowerCase().split('/').pop() ?? '';
  return name.startsWith('gpt-5') || /^o\d/.test(name);
}

export function unsupportedParameters(message: string): string[] {
  const found: string[] = [];
  for (const match of message.matchAll(/'([A-Za-z0-9_]+)'/g)) {
    const name = match[1] ?? '';
    if (SAMPLING_PARAMETERS.has(name) && !found.includes(name)) found.push(name);
  }
  return found;
}

export function openAiChatBody(request: ProviderRequest, omit: ReadonlySet<string> = new Set()): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    stream: true,
    messages: [{ role: 'system', content: request.system }, ...request.messages.map(toOpenAiMessage)],
  };
  if (request.tools.length > 0 && !omit.has('tools')) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: schemaOf(tool),
      },
    }));
  }
  if (isReasoningModel(request.model)) {
    if (!omit.has('max_completion_tokens')) body.max_completion_tokens = REASONING_MAX_COMPLETION_TOKENS;
    if (request.reasoningEffort && !omit.has('reasoning_effort')) body.reasoning_effort = request.reasoningEffort;
    return body;
  }
  if (request.temperature !== undefined && !omit.has('temperature')) body.temperature = request.temperature;
  return body;
}

export function createOpenAiProvider(fetchImpl: typeof fetch = fetch): ChatProvider {
  return {
    id: 'openai',
    async stream(request, onChunk, signal) {
      if (signal?.aborted) throw new StreamCancelled();
      if (!request.apiKey) throw new Error('Add an OpenAI-compatible API key in Settings.');
      const base = (request.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
      if (isReasoningModel(request.model) && request.showReasoning !== false) {
        try {
          return await streamResponses(base, request, onChunk, signal, fetchImpl);
        } catch (error) {
          if (isCancellation(error) || !(error instanceof ResponsesUnsupported)) throw error;
        }
      }
      const omit = new Set<string>();
      let response: Response | undefined;
      let failure = '';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        response = await fetchImpl(`${base}/chat/completions`, {
          method: 'POST',
          signal,
          headers: {
            Authorization: `Bearer ${request.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(openAiChatBody(request, omit)),
        });
        if (response.ok) break;
        failure = await errorText(response, 'The model provider rejected the request');
        const dropped = unsupportedParameters(failure).filter((name) => !omit.has(name));
        if (attempt === 1 || dropped.length === 0) throw new Error(failure);
        for (const name of dropped) omit.add(name);
      }
      if (!response?.ok) throw new Error(failure || 'The model provider rejected the request.');
      let content = '';
      const calls = new Map<number, ProviderToolCall>();
      try {
        await readSse(response, (data) => {
          const parsed = parseOpenAiData(data);
          if (!parsed || parsed === 'done') return;
          if (parsed.reasoning && request.showReasoning !== false) {
            onChunk({ type: 'reasoning', delta: parsed.reasoning });
          }
          if (parsed.text) {
            content += parsed.text;
            onChunk({ type: 'text', delta: parsed.text });
          }
          for (const call of parsed.toolCalls) {
            const current = calls.get(call.index) ?? { id: '', name: '', arguments: '' };
            if (call.id) current.id = call.id;
            if (call.name) current.name = call.name;
            if (call.arguments) current.arguments += call.arguments;
            calls.set(call.index, current);
          }
        });
      } catch (error) {
        if (isCancellation(error)) throw new StreamCancelled();
        throw error;
      }
      return { content, toolCalls: [...calls.values()].filter((call) => call.name) };
    },
  };
}

class ResponsesUnsupported extends Error {
  constructor() {
    super('This endpoint does not accept the Responses API.');
    this.name = 'ResponsesUnsupported';
  }
}

async function streamResponses(
  base: string,
  request: ProviderRequest,
  onChunk: (chunk: { type: 'text' | 'reasoning'; delta: string }) => void,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ content: string; toolCalls: ProviderToolCall[] }> {
  const response = await fetchImpl(`${base}/responses`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(openAiResponsesBody(request)),
  });
  if (response.status === 404 || response.status === 405) throw new ResponsesUnsupported();
  if (!response.ok) throw new Error(await errorText(response, 'The model provider rejected the request'));
  let content = '';
  const calls = new Map<number, ProviderToolCall>();
  try {
    await readSse(response, (data) => {
      const parsed = parseOpenAiData(data);
      if (!parsed || parsed === 'done') return;
      if (parsed.reasoning) onChunk({ type: 'reasoning', delta: parsed.reasoning });
      if (parsed.text) {
        content += parsed.text;
        onChunk({ type: 'text', delta: parsed.text });
      }
      for (const call of parsed.toolCalls) {
        const current = calls.get(call.index) ?? { id: '', name: '', arguments: '' };
        if (call.id) current.id = call.id;
        if (call.name) current.name = call.name;
        if (call.arguments) current.arguments += call.arguments;
        calls.set(call.index, current);
      }
    });
  } catch (error) {
    if (isCancellation(error)) throw new StreamCancelled();
    throw error;
  }
  return { content, toolCalls: [...calls.values()].filter((call) => call.name) };
}

export function openAiResponsesBody(request: ProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    stream: true,
    instructions: request.system,
    input: toResponsesInput(request.messages),
    max_output_tokens: REASONING_MAX_COMPLETION_TOKENS,
    reasoning: { effort: request.reasoningEffort ?? 'medium', summary: 'auto' },
  };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description ?? '',
      parameters: schemaOf(tool),
    }));
  }
  return body;
}

function toResponsesInput(messages: ProviderMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      if (message.content) input.push({ role: 'assistant', content: message.content });
      for (const call of message.toolCalls) {
        input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
      }
      continue;
    }
    input.push({ role: message.role, content: message.content });
  }
  return input;
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
