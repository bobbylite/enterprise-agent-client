import { createAnthropicProvider } from './anthropic';
import { createGenericProvider } from './generic';
import { createMockProvider } from './mock';
import { createOpenAiProvider } from './openai';
import type { ChatProvider } from './types';
import type { ProviderId } from '../types';

export function createProvider(
  id: ProviderId,
  options: { fetchImpl?: typeof fetch; delayMs?: number } = {},
): ChatProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  switch (id) {
    case 'mock':
      return createMockProvider(options.delayMs ?? 12);
    case 'openai':
      return createOpenAiProvider(fetchImpl);
    case 'anthropic':
      return createAnthropicProvider(fetchImpl);
    case 'generic':
      return createGenericProvider(fetchImpl);
  }
}

export function defaultModelFor(id: ProviderId, configured: {
  openaiModel: string;
  anthropicModel: string;
  genericModel: string;
}): string {
  switch (id) {
    case 'mock':
      return 'mock-1';
    case 'openai':
      return configured.openaiModel;
    case 'anthropic':
      return configured.anthropicModel;
    case 'generic':
      return configured.genericModel;
  }
}
