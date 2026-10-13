export async function readSse(response: Response, onData: (data: string) => void): Promise<void> {
  if (!response.body) {
    const text = await response.text();
    if (text) onData(text);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n');
    buffer = chunks.pop() ?? '';
    for (const line of chunks) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      onData(trimmed.slice(5).trim());
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith('data:')) onData(tail.slice(5).trim());
}

export interface OpenAiDelta {
  text: string;
  reasoning: string;
  toolCalls: { index: number; id?: string; name?: string; arguments?: string }[];
}

export function parseOpenAiData(data: string): OpenAiDelta | 'done' | null {
  if (data === '[DONE]') return 'done';
  let parsed: { type?: string; delta?: unknown; output_index?: number; item?: Record<string, unknown>; choices?: { delta?: Record<string, unknown> }[] };
  try {
    parsed = JSON.parse(data) as typeof parsed;
  } catch {
    return null;
  }
  if (typeof parsed.type === 'string' && parsed.type.startsWith('response.')) {
    return parseResponsesEvent(parsed);
  }
  const delta = parsed.choices?.[0]?.delta ?? {};
  const text = typeof delta.content === 'string' ? delta.content : '';
  const reasoning = reasoningText(delta);
  const toolCalls: OpenAiDelta['toolCalls'] = [];
  const rawCalls = delta.tool_calls;
  if (Array.isArray(rawCalls)) {
    for (const call of rawCalls) {
      const record = call as {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      };
      toolCalls.push({
        index: record.index ?? 0,
        id: record.id,
        name: record.function?.name,
        arguments: record.function?.arguments,
      });
    }
  }
  return { text, reasoning, toolCalls };
}

function reasoningText(delta: Record<string, unknown>): string {
  for (const key of ['reasoning', 'reasoning_content', 'reasoning_summary']) {
    const value = delta[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function parseResponsesEvent(parsed: {
  type?: string;
  delta?: unknown;
  output_index?: number;
  item?: Record<string, unknown>;
}): OpenAiDelta | 'done' | null {
  const index = parsed.output_index ?? 0;
  if (parsed.type === 'response.reasoning_summary_text.delta' || parsed.type === 'response.reasoning_text.delta') {
    return { text: '', reasoning: typeof parsed.delta === 'string' ? parsed.delta : '', toolCalls: [] };
  }
  if (parsed.type === 'response.output_text.delta') {
    return { text: typeof parsed.delta === 'string' ? parsed.delta : '', reasoning: '', toolCalls: [] };
  }
  if (parsed.type === 'response.output_item.added' && parsed.item?.type === 'function_call') {
    return {
      text: '',
      reasoning: '',
      toolCalls: [
        {
          index,
          id: typeof parsed.item.call_id === 'string' ? parsed.item.call_id : typeof parsed.item.id === 'string' ? parsed.item.id : undefined,
          name: typeof parsed.item.name === 'string' ? parsed.item.name : undefined,
          arguments: '',
        },
      ],
    };
  }
  if (parsed.type === 'response.function_call_arguments.delta') {
    return {
      text: '',
      reasoning: '',
      toolCalls: [{ index, arguments: typeof parsed.delta === 'string' ? parsed.delta : '' }],
    };
  }
  if (parsed.type === 'response.completed' || parsed.type === 'response.failed') return 'done';
  return null;
}

export interface AnthropicDelta {
  text?: string;
  reasoning?: string;
  tool?: { index: number; id?: string; name?: string; partialJson?: string };
}

export function parseAnthropicData(data: string): AnthropicDelta | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.type === 'content_block_start') {
    const block = parsed.content_block as { type?: string; id?: string; name?: string } | undefined;
    if (block?.type === 'tool_use') {
      return { tool: { index: Number(parsed.index ?? 0), id: block.id, name: block.name, partialJson: '' } };
    }
  }
  if (parsed.type === 'content_block_delta') {
    const delta = parsed.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined;
    if (delta?.type === 'text_delta' && delta.text) return { text: delta.text };
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
      return { reasoning: delta.thinking };
    }
    if (delta?.type === 'input_json_delta') {
      return { tool: { index: Number(parsed.index ?? 0), partialJson: delta.partial_json ?? '' } };
    }
  }
  return null;
}
