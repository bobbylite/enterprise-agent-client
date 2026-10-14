import { ChatAnthropic } from '@langchain/anthropic';
import { AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage, collapseToolCallChunks, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel, type BaseChatModelCallOptions, type BindToolsInput } from '@langchain/core/language_models/chat_models';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { ChatOpenAI } from '@langchain/openai';
import type { OpenAI } from 'openai';
import { ANTHROPIC_THINKING_BUDGET } from '@shared/providers/anthropic';
import { createGenericProvider } from '@shared/providers/generic';
import { mockResult } from '@shared/providers/mock';
import { isReasoningModel, unsupportedParameters } from '@shared/providers/openai';
import {
  StreamCancelled,
  isCancellation,
  type ProviderMessage,
  type ProviderToolCall,
  type ReasoningEffort,
} from '@shared/providers/types';
import type { ProviderId } from '@shared/types';
import type { RuntimeTool } from './runtime-tool';

export interface ModelTurnMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ProviderToolCall[];
  attachments?: { name: string; mime: string; dataBase64?: string; text?: string }[];
}

export interface ModelTurnInput {
  provider: ProviderId;
  model: string;
  system: string;
  messages: ModelTurnMessage[];
  tools: RuntimeTool[];
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  showReasoning: boolean;
  apiKey?: string;
  baseUrl?: string;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onChunk: (chunk: { type: 'text' | 'reasoning'; delta: string }) => void;
}

export interface OpenAiTurnFields {
  model: string;
  temperature?: number;
  useResponsesApi: boolean;
  reasoning?: OpenAI.Reasoning;
}

export function openAiTurnFields(input: {
  model: string;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  showReasoning: boolean;
  omit?: ReadonlySet<string>;
}): OpenAiTurnFields {
  const omit = input.omit ?? new Set<string>();
  const reasoning = isReasoningModel(input.model);
  const fields: OpenAiTurnFields = {
    model: input.model,
    useResponsesApi: reasoning && input.showReasoning && !omit.has('responses'),
  };
  if (!reasoning && input.temperature !== undefined && !omit.has('temperature')) fields.temperature = input.temperature;
  if (reasoning && !omit.has('reasoning_effort')) {
    const effort = input.reasoningEffort ?? (input.showReasoning ? 'medium' : undefined);
    if (effort) {
      fields.reasoning = {
        effort,
        ...(input.showReasoning ? { summary: 'auto' as const } : {}),
      };
    }
  }
  return fields;
}

export function anthropicTurnFields(input: {
  model: string;
  temperature?: number;
  showReasoning: boolean;
}): { model: string; temperature?: number; maxTokens: number; thinking?: { type: 'enabled'; budget_tokens: number } } {
  if (input.showReasoning) {
    return {
      model: input.model,
      maxTokens: ANTHROPIC_THINKING_BUDGET + 2048,
      thinking: { type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGET },
    };
  }
  return {
    model: input.model,
    maxTokens: 4096,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  };
}

export async function streamLangChainTurn(
  input: ModelTurnInput,
): Promise<{ content: string; toolCalls: ProviderToolCall[] }> {
  if (input.signal?.aborted) throw new StreamCancelled();
  if (input.provider === 'mock') return streamMock(input);
  if (input.provider === 'generic') return streamGeneric(input);
  if (input.provider === 'anthropic') return streamAnthropic(input);
  return streamOpenAi(input);
}

async function streamOpenAi(input: ModelTurnInput): Promise<{ content: string; toolCalls: ProviderToolCall[] }> {
  if (!input.apiKey) throw new Error('Add an OpenAI-compatible API key in Settings.');
  const omit = new Set<string>();
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fields = openAiTurnFields({ ...input, omit });
    try {
      const openAi = new ChatOpenAI({
        model: fields.model,
        apiKey: input.apiKey,
        temperature: fields.temperature,
        streaming: true,
        useResponsesApi: fields.useResponsesApi,
        reasoning: fields.reasoning,
        maxRetries: 0,
        configuration: {
          baseURL: input.baseUrl || undefined,
          fetch: input.fetchImpl,
        },
      });
      return await consumeModel(
        input.tools.length > 0 ? openAi.bindTools(toolBindings(input.tools, 'openai')) : openAi,
        toLangChainMessages(input.system, input.messages),
        input,
      );
    } catch (error) {
      if (isCancellation(error)) throw error;
      last = error;
      const message = error instanceof Error ? error.message : String(error);
      const dropped = unsupportedParameters(message).filter((name) => !omit.has(name));
      if (fields.useResponsesApi && !omit.has('responses')) {
        omit.add('responses');
        continue;
      }
      if (dropped.length === 0 || attempt === 2) break;
      for (const name of dropped) omit.add(name);
    }
  }
  throw last instanceof Error ? last : new Error('The model provider rejected the request.');
}

async function streamAnthropic(input: ModelTurnInput): Promise<{ content: string; toolCalls: ProviderToolCall[] }> {
  if (!input.apiKey) throw new Error('Add an Anthropic API key in Settings.');
  const fields = anthropicTurnFields(input);
  const anthropic = new ChatAnthropic({
    model: fields.model,
    apiKey: input.apiKey,
    anthropicApiUrl: input.baseUrl || undefined,
    temperature: fields.temperature,
    maxTokens: fields.maxTokens,
    thinking: fields.thinking,
    streaming: true,
    clientOptions: { fetch: input.fetchImpl },
  });
  return consumeModel(
    input.tools.length > 0 ? anthropic.bindTools(toolBindings(input.tools)) : anthropic,
    toLangChainMessages(input.system, input.messages),
    input,
  );
}

async function streamGeneric(input: ModelTurnInput): Promise<{ content: string; toolCalls: ProviderToolCall[] }> {
  const model = new GenericChatModel({
    request: providerRequest(input),
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  }).bindTools(toolBindings(input.tools));
  return consumeModel(model, toLangChainMessages(input.system, input.messages), input);
}

async function streamMock(input: ModelTurnInput): Promise<{ content: string; toolCalls: ProviderToolCall[] }> {
  const model = new MockChatModel({
    request: providerRequest(input),
    delayMs: input.delayMs ?? 0,
    signal: input.signal,
  });
  return consumeModel(model, [new HumanMessage('turn')], input);
}

function providerRequest(input: ModelTurnInput) {
  return {
    model: input.model,
    system: input.system,
    messages: input.messages as ProviderMessage[],
    tools: input.tools.map((tool) => ({
      name: tool.key,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    temperature: input.temperature,
    reasoningEffort: input.reasoningEffort,
    showReasoning: input.showReasoning,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
  };
}

function toolBindings(tools: RuntimeTool[], format: 'langchain' | 'openai' = 'langchain'): BindToolsInput[] {
  return tools.map((tool) => {
    if (format === 'openai' && tool.strict) {
      return {
        type: 'function',
        function: {
          name: tool.key,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: true,
        },
        strict: true,
      };
    }
    return {
      name: tool.key,
      description: tool.description,
      schema: tool.inputSchema,
    };
  });
}

async function consumeModel(
  model: { stream: (messages: BaseMessage[], options?: { signal?: AbortSignal }) => Promise<AsyncIterable<AIMessageChunk>> },
  messages: BaseMessage[],
  input: ModelTurnInput,
): Promise<{ content: string; toolCalls: ProviderToolCall[] }> {
  let content = '';
  const chunks: AIMessageChunk[] = [];
  const stream = await model.stream(messages, { signal: input.signal });
  for await (const chunk of stream) {
    if (input.signal?.aborted) throw new StreamCancelled();
    chunks.push(chunk);
    const parts = readChunk(chunk);
    if (parts.reasoning && input.showReasoning) input.onChunk({ type: 'reasoning', delta: parts.reasoning });
    if (parts.text) {
      content += parts.text;
      input.onChunk({ type: 'text', delta: parts.text });
    }
  }
  if (input.signal?.aborted) throw new StreamCancelled();
  return { content, toolCalls: collectStreamedToolCalls(chunks) };
}

export function collectStreamedToolCalls(chunks: AIMessageChunk[]): ProviderToolCall[] {
  logRawToolCalls(chunks);
  const pieces = chunks.flatMap((chunk) => chunk.tool_call_chunks ?? []);
  if (pieces.length > 0) {
    const collapsed = collapseToolCallChunks(pieces);
    const parsed = collapsed.tool_calls.flatMap((call) => toProviderCall(call.name, call.id, call.args));
    if (parsed.length > 0) return parsed;
    return collapsed.invalid_tool_calls.flatMap((call) => toProviderCall(call.name, call.id, call.args));
  }
  const calls = new Map<string, ProviderToolCall>();
  for (const chunk of chunks) {
    for (const call of chunk.tool_calls ?? []) {
      const provider = toProviderCall(call.name, call.id, call.args)[0];
      if (provider) calls.set(provider.id, provider);
    }
  }
  return [...calls.values()];
}

function toProviderCall(name: string | undefined, id: string | undefined, args: unknown): ProviderToolCall[] {
  if (!name) return [];
  const argumentsText = typeof args === 'string' ? args || '{}' : JSON.stringify(args ?? {});
  return [{ id: id || name, name, arguments: argumentsText }];
}

function logRawToolCalls(chunks: AIMessageChunk[]): void {
  if (process.env.AGENT_DEBUG !== '1') return;
  const raw = chunks.flatMap((chunk) => [
    ...(chunk.tool_call_chunks ?? []).map((call) => ({
      kind: 'chunk',
      id: call.id,
      name: call.name,
      index: call.index,
      args: call.args,
    })),
    ...(chunk.tool_calls ?? []).map((call) => ({ kind: 'call', id: call.id, name: call.name, args: call.args })),
  ]);
  if (raw.length === 0) return;
  console.error(`[agent] raw tool-call args ${JSON.stringify(raw)}`);
}

export function readModelChunk(chunk: AIMessageChunk): { text: string; reasoning: string } {
  return readChunk(chunk);
}

function readChunk(chunk: AIMessageChunk): { text: string; reasoning: string } {
  let text = '';
  let reasoning = '';
  const blocks = chunk.contentBlocks ?? [];
  if (blocks.length > 0) {
    for (const block of blocks) {
      if (block.type === 'text') text += block.text ?? '';
      else reasoning += reasoningBlockText(block);
    }
  } else if (typeof chunk.content === 'string') {
    text += chunk.content;
  } else if (Array.isArray(chunk.content)) {
    for (const block of chunk.content) {
      if (typeof block === 'string') text += block;
      else if (block && typeof block === 'object') {
        const record = block as { type?: string; text?: string };
        if (record.type === 'text' && record.text) text += record.text;
        else reasoning += reasoningBlockText(record);
      }
    }
  }
  if (!reasoning) reasoning = reasoningSummary(chunk.additional_kwargs?.reasoning);
  return { text, reasoning };
}

function reasoningBlockText(block: object): string {
  const record = block as { type?: string; reasoning?: unknown; thinking?: unknown; summary?: unknown };
  if (record.type !== 'reasoning' && record.type !== 'thinking') return '';
  if (typeof record.reasoning === 'string' && record.reasoning) return record.reasoning;
  if (typeof record.thinking === 'string' && record.thinking) return record.thinking;
  return reasoningSummary(record);
}

function reasoningSummary(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const summary = (value as { summary?: unknown }).summary;
  if (typeof summary === 'string') return summary;
  if (!Array.isArray(summary)) return '';
  return summary
    .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
    .join('');
}

function toLangChainMessages(system: string, messages: ModelTurnMessage[]): BaseMessage[] {
  const converted: BaseMessage[] = [new SystemMessage(system)];
  for (const message of messages) {
    if (message.role === 'user') {
      const images = (message.attachments ?? []).filter((item) => item.dataBase64 && item.mime.startsWith('image/'));
      if (images.length === 0) {
        converted.push(new HumanMessage(message.content));
      } else {
        converted.push(
          new HumanMessage({
            content: [
              { type: 'text', text: message.content },
              ...images.map((item) => ({
                type: 'image_url' as const,
                image_url: { url: `data:${item.mime};base64,${item.dataBase64}` },
              })),
            ],
          }),
        );
      }
      continue;
    }
    if (message.role === 'assistant') {
      converted.push(
        new AIMessage({
          content: message.content,
          tool_calls: (message.toolCalls ?? []).map((call) => ({
            id: call.id,
            name: call.name,
            args: parseArgs(call.arguments),
            type: 'tool_call' as const,
          })),
        }),
      );
      continue;
    }
    converted.push(new ToolMessage({ content: message.content, tool_call_id: message.toolCallId ?? '' }));
  }
  return converted;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { raw };
  }
}

class MockChatModel extends BaseChatModel {
  private readonly request: ReturnType<typeof providerRequest>;
  private readonly delayMs: number;
  private readonly abortSignal?: AbortSignal;

  constructor(fields: { request: ReturnType<typeof providerRequest>; delayMs?: number; signal?: AbortSignal }) {
    super({});
    this.request = fields.request;
    this.delayMs = fields.delayMs ?? 0;
    this.abortSignal = fields.signal;
  }

  _llmType(): string {
    return 'enterprise-mock';
  }

  bindTools(tools: BindToolsInput[]): this {
    const mapped = tools.map((tool) => {
      const record = tool as { name?: string; description?: string; schema?: Record<string, unknown> };
      return {
        name: record.name ?? 'tool',
        description: record.description ?? '',
        inputSchema: record.schema ?? { type: 'object', properties: {} },
      };
    });
    return new MockChatModel({
      request: { ...this.request, tools: mapped },
      delayMs: this.delayMs,
      signal: this.abortSignal,
    }) as this;
  }

  async _generate(messages: BaseMessage[], options: BaseChatModelCallOptions): Promise<ChatResult> {
    const chunks: ChatGenerationChunk[] = [];
    for await (const chunk of this._streamResponseChunks(messages, options)) chunks.push(chunk);
    const message = chunks.reduce<AIMessageChunk | undefined>((left, chunk) => {
      const next = chunk.message as AIMessageChunk;
      return left ? left.concat(next) : next;
    }, undefined);
    return { generations: [{ message: message ?? new AIMessage(''), text: message?.text ?? '' }] };
  }

  async *_streamResponseChunks(
    _messages: BaseMessage[],
    options: BaseChatModelCallOptions,
  ): AsyncGenerator<ChatGenerationChunk> {
    const signal = options.signal ?? this.abortSignal;
    const result = mockResult(this.request);
    if (this.request.showReasoning !== false) {
      for (const part of parts('Checking the request against the session policy. ')) {
        if (signal?.aborted) throw new StreamCancelled();
        yield chunkOf({ reasoning: part });
        await pause(this.delayMs);
      }
    }
    for (const part of parts(result.content)) {
      if (signal?.aborted) throw new StreamCancelled();
      yield chunkOf({ text: part });
      await pause(this.delayMs);
    }
    if (result.toolCalls.length > 0) {
      if (signal?.aborted) throw new StreamCancelled();
      yield new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk({
          content: '',
          tool_calls: result.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            args: parseArgs(call.arguments),
            type: 'tool_call' as const,
          })),
        }),
      });
    }
  }
}

class GenericChatModel extends BaseChatModel {
  private request: ReturnType<typeof providerRequest>;
  private readonly fetchImpl?: typeof fetch;
  private readonly abortSignal?: AbortSignal;

  constructor(fields: { request: ReturnType<typeof providerRequest>; fetchImpl?: typeof fetch; signal?: AbortSignal }) {
    super({});
    this.request = fields.request;
    this.fetchImpl = fields.fetchImpl;
    this.abortSignal = fields.signal;
  }

  _llmType(): string {
    return 'enterprise-generic';
  }

  bindTools(tools: BindToolsInput[]): this {
    const mapped = tools.map((tool) => {
      const record = tool as { name?: string; description?: string; schema?: Record<string, unknown> };
      return {
        name: record.name ?? 'tool',
        description: record.description ?? '',
        inputSchema: record.schema ?? { type: 'object', properties: {} },
      };
    });
    const next = new GenericChatModel({ request: { ...this.request, tools: mapped }, fetchImpl: this.fetchImpl, signal: this.abortSignal });
    return next as this;
  }

  async _generate(messages: BaseMessage[], options: BaseChatModelCallOptions): Promise<ChatResult> {
    const chunks: ChatGenerationChunk[] = [];
    for await (const chunk of this._streamResponseChunks(messages, options)) chunks.push(chunk);
    const combined = chunks.at(-1);
    return { generations: [{ message: combined?.message ?? new AIMessage(''), text: '' }] };
  }

  async *_streamResponseChunks(
    _messages: BaseMessage[],
    options: BaseChatModelCallOptions,
  ): AsyncGenerator<ChatGenerationChunk> {
    const queue: ({ type: 'text' | 'reasoning'; delta: string } | { type: 'end' })[] = [];
    let wake: (() => void) | undefined;
    let failure: unknown;
    let toolCalls: ProviderToolCall[] = [];
    const finished = createGenericProvider(this.fetchImpl)
      .stream(
        this.request,
        (chunk) => {
          queue.push(chunk);
          wake?.();
          wake = undefined;
        },
        options.signal ?? this.abortSignal,
      )
      .then(
        (result) => {
          toolCalls = result.toolCalls;
          queue.push({ type: 'end' });
          wake?.();
        },
        (error: unknown) => {
          failure = error;
          queue.push({ type: 'end' });
          wake?.();
        },
      );
    while (true) {
      if (queue.length === 0) await new Promise<void>((resolve) => {
        wake = resolve;
      });
      const next = queue.shift();
      if (!next || next.type === 'end') break;
      if (next.type === 'reasoning') yield chunkOf({ reasoning: next.delta });
      else yield chunkOf({ text: next.delta });
    }
    await finished;
    if (failure) throw failure;
    if (toolCalls.length === 0) return;
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk({
        content: '',
        tool_calls: toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          args: parseArgs(call.arguments),
          type: 'tool_call' as const,
        })),
      }),
    });
  }
}

function chunkOf(input: { text?: string; reasoning?: string }): ChatGenerationChunk {
  if (input.reasoning) {
    return new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk({
        content: [{ type: 'reasoning', reasoning: input.reasoning }],
        additional_kwargs: { reasoning: input.reasoning },
      }),
    });
  }
  return new ChatGenerationChunk({
    text: input.text ?? '',
    message: new AIMessageChunk(input.text ?? ''),
  });
}

function parts(text: string): string[] {
  return text.split(/(\s+)/).filter((part) => part.length > 0);
}

function pause(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
