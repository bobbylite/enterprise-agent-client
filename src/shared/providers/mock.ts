import type { ChatProvider, ProviderRequest, ProviderResult, ProviderToolCall } from './types';

export function createMockProvider(delayMs = 12): ChatProvider {
  return {
    id: 'mock',
    async stream(request, onDelta, signal) {
      const result = mockResult(request);
      const parts = result.content.split(/(\s+)/);
      for (const part of parts) {
        if (!part) continue;
        if (signal?.aborted) throw new Error('The response was cancelled.');
        onDelta(part);
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return result;
    },
  };
}

export function mockResult(request: ProviderRequest): ProviderResult {
  const risk = /Risk level:\s*(\S+)/.exec(request.system);
  const action = /Policy action:\s*(\S+)/.exec(request.system);
  const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
  const lastTool = [...request.messages].reverse().find((message) => message.role === 'tool');
  const echo = lastUser ? /^echo\s+([\s\S]+)/i.exec(lastUser.content.trim()) : null;
  const echoTool = request.tools.find((tool) => tool.name === 'echo' || tool.name.endsWith('__echo'));
  const sawToolResult = lastTool && lastUser && request.messages.indexOf(lastTool) > request.messages.indexOf(lastUser);
  const riskLine = risk
    ? `This session is ${risk[1].replace('.', '')} risk${action ? ` and the policy says ${action[1].replaceAll('_', ' ').replace('.', '')}` : ''}. `
    : '';

  if (sawToolResult && lastTool) {
    return { content: `${riskLine}The tool returned:\n\n${lastTool.content}`, toolCalls: [] };
  }

  if (echo && echoTool) {
    const toolCalls: ProviderToolCall[] = [
      {
        id: 'call_mock_echo',
        name: echoTool.name,
        arguments: JSON.stringify({ message: echo[1] }),
      },
    ];
    return { content: '', toolCalls };
  }

  const attachmentNote =
    lastUser?.attachments && lastUser.attachments.length > 0
      ? ` I can see ${lastUser.attachments.map((item) => item.name).join(', ')}.`
      : '';
  return {
    content: `${riskLine}I can help with that.${attachmentNote} Ask me to "echo ..." to try a tool call. Tool calls wait for your approval.`,
    toolCalls: [],
  };
}
