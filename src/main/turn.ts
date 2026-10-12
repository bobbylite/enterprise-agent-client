import { randomId } from '@shared/ids';
import { choiceFromUser, previewApproval, type ApprovalDecision, type ApprovalPreview } from '@shared/mcp/approvals';
import type { ChatProvider, ProviderMessage, ProviderRequest } from '@shared/providers/types';
import type { ApprovalChoice, ApprovalRequest, ChatEvent, RiskAction, ToolInvocation } from '@shared/types';

export interface RuntimeTool {
  key: string;
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean;
}

export async function runAgentTurn(input: {
  provider: ChatProvider;
  request: Omit<ProviderRequest, 'messages' | 'tools'>;
  messages: ProviderMessage[];
  tools: RuntimeTool[];
  conversationId: string;
  author: { id: string; name: string };
  riskAction: RiskAction;
  remembered: (serverId: string, toolName: string) => 'always' | 'deny' | undefined;
  rememberAlways: (serverId: string, toolName: string) => void;
  requestApproval: (request: ApprovalRequest) => Promise<ApprovalChoice>;
  callTool: (tool: RuntimeTool, args: unknown) => Promise<string>;
  persistMessage: (message: {
    id: string;
    content: string;
    authorId: string;
    authorName: string;
  }) => void;
  persistTool: (tool: ToolInvocation) => void;
  emit: (event: ChatEvent) => void;
  maxRounds?: number;
}): Promise<string> {
  const history = [...input.messages];
  let finalText = '';
  const rounds = input.maxRounds ?? 4;

  for (let round = 0; round < rounds; round += 1) {
    const messageId = randomId();
    input.emit({
      type: 'assistant-start',
      conversationId: input.conversationId,
      messageId,
      authorId: input.author.id,
      authorName: input.author.name,
    });
    const result = await input.provider.stream(
      {
        ...input.request,
        messages: history,
        tools: input.tools.map((tool) => ({
          name: tool.key,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      },
      (delta) => {
        input.emit({ type: 'assistant-delta', conversationId: input.conversationId, messageId, delta });
      },
    );
    input.persistMessage({
      id: messageId,
      content: result.content,
      authorId: input.author.id,
      authorName: input.author.name,
    });
    input.emit({ type: 'assistant-done', conversationId: input.conversationId, messageId });
    finalText = result.content;
    history.push({
      role: 'assistant',
      content: result.content,
      toolCalls: result.toolCalls,
    });
    if (result.toolCalls.length === 0) break;

    for (const call of result.toolCalls) {
      const tool = input.tools.find((item) => item.key === call.name);
      const invocationId = call.id || randomId();
      if (!tool) {
        const denied: ToolInvocation = {
          id: invocationId,
          messageId,
          serverId: 'unknown',
          serverName: 'unknown',
          toolName: call.name,
          args: call.arguments,
          result: 'That tool is not connected.',
          status: 'denied',
          approval: 'automatic',
        };
        input.persistTool(denied);
        input.emit({ type: 'tool', conversationId: input.conversationId, messageId, tool: denied });
        history.push({ role: 'tool', toolCallId: invocationId, name: call.name, content: denied.result ?? '' });
        continue;
      }

      let args: unknown = {};
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        args = { raw: call.arguments };
      }

      const preview = previewApproval({
        riskAction: input.riskAction,
        readOnlyHint: tool.readOnlyHint,
        remembered: input.remembered(tool.serverId, tool.name) ?? undefined,
      });
      const outcome = await resolveApproval(preview, async () => {
        if (preview.type !== 'prompt') return 'deny';
        const choice = await input.requestApproval({
          id: invocationId,
          conversationId: input.conversationId,
          serverId: tool.serverId,
          serverName: tool.serverName,
          toolName: tool.name,
          argumentsText: JSON.stringify(args, null, 2),
          readOnlyHint: tool.readOnlyHint,
          riskAction: input.riskAction,
          allowAlways: preview.allowAlways,
        });
        if (choice === 'always' && preview.allowAlways) input.rememberAlways(tool.serverId, tool.name);
        return choice;
      });

      if (outcome.type === 'deny') {
        const denied: ToolInvocation = {
          id: invocationId,
          messageId,
          serverId: tool.serverId,
          serverName: tool.serverName,
          toolName: tool.name,
          args,
          result: outcome.reason,
          status: 'denied',
          approval: outcome.automatic ? 'automatic' : 'deny',
        };
        input.persistTool(denied);
        input.emit({ type: 'tool', conversationId: input.conversationId, messageId, tool: denied });
        history.push({ role: 'tool', toolCallId: invocationId, name: tool.key, content: outcome.reason });
        continue;
      }

      let resultText: string;
      let status: ToolInvocation['status'] = 'done';
      try {
        resultText = await input.callTool(tool, args);
      } catch (error) {
        status = 'error';
        resultText = error instanceof Error ? error.message : String(error);
      }
      const invocation: ToolInvocation = {
        id: invocationId,
        messageId,
        serverId: tool.serverId,
        serverName: tool.serverName,
        toolName: tool.name,
        args,
        result: resultText,
        status,
        approval: outcome.persistence,
      };
      input.persistTool(invocation);
      input.emit({ type: 'tool', conversationId: input.conversationId, messageId, tool: invocation });
      history.push({ role: 'tool', toolCallId: invocationId, name: tool.key, content: resultText });
    }
  }

  return finalText;
}

async function resolveApproval(
  preview: ApprovalPreview,
  ask: () => Promise<ApprovalChoice>,
): Promise<ApprovalDecision> {
  if (preview.type === 'prompt') return choiceFromUser(await ask(), preview.allowAlways);
  return preview;
}
