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
  apiKey?: string;
  baseUrl?: string;
}

export interface ProviderResult {
  content: string;
  toolCalls: ProviderToolCall[];
}

export interface ChatProvider {
  id: string;
  stream(
    request: ProviderRequest,
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<ProviderResult>;
}

export function schemaOf(tool: ProviderTool): Record<string, unknown> {
  if (tool.inputSchema && typeof tool.inputSchema === 'object' && Object.keys(tool.inputSchema).length > 0) {
    return tool.inputSchema;
  }
  return { type: 'object', properties: {} };
}
