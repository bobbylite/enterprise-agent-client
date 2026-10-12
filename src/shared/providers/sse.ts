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
  toolCalls: { index: number; id?: string; name?: string; arguments?: string }[];
}

export function parseOpenAiData(data: string): OpenAiDelta | 'done' | null {
  if (data === '[DONE]') return 'done';
  let parsed: { choices?: { delta?: Record<string, unknown> }[] };
  try {
    parsed = JSON.parse(data) as { choices?: { delta?: Record<string, unknown> }[] };
  } catch {
    return null;
  }
  const delta = parsed.choices?.[0]?.delta ?? {};
  const text = typeof delta.content === 'string' ? delta.content : '';
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
  return { text, toolCalls };
}

export interface AnthropicDelta {
  text?: string;
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
    const delta = parsed.delta as { type?: string; text?: string; partial_json?: string } | undefined;
    if (delta?.type === 'text_delta' && delta.text) return { text: delta.text };
    if (delta?.type === 'input_json_delta') {
      return { tool: { index: Number(parsed.index ?? 0), partialJson: delta.partial_json ?? '' } };
    }
  }
  return null;
}
