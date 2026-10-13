export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ProviderAttachment {
  name: string;
  mime: string;
  dataBase64?: string;
  text?: string;
}

export interface ProviderMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ProviderToolCall[];
  attachments?: ProviderAttachment[];
}

export interface ProviderTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface ProviderRequest {
  model: string;
  system: string;
  messages: ProviderMessage[];
  tools: ProviderTool[];
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  /** When false, providers skip reasoning summaries and extended thinking. */
  showReasoning?: boolean;
  apiKey?: string;
  baseUrl?: string;
}

export interface StreamChunk {
  type: 'text' | 'reasoning';
  delta: string;
}

export class StreamCancelled extends Error {
  constructor() {
    super('The response was cancelled.');
    this.name = 'StreamCancelled';
  }
}

export function isCancellation(error: unknown): boolean {
  if (error instanceof StreamCancelled) return true;
  return Boolean(error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError');
}

export interface ProviderResult {
  content: string;
  toolCalls: ProviderToolCall[];
}

export interface ChatProvider {
  id: string;
  stream(
    request: ProviderRequest,
    onChunk: (chunk: StreamChunk) => void,
    signal?: AbortSignal,
  ): Promise<ProviderResult>;
}

export function schemaOf(tool: ProviderTool): Record<string, unknown> {
  if (tool.inputSchema && typeof tool.inputSchema === 'object' && Object.keys(tool.inputSchema).length > 0) {
    return tool.inputSchema;
  }
  return { type: 'object', properties: {} };
}
