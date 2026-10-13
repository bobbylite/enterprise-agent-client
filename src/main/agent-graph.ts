import { Annotation, Command, END, GraphInterrupt, START, StateGraph, interrupt } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { randomId } from '@shared/ids';
import { composeInstructions } from '@shared/instructions/compose';
import { choiceFromUser, previewApproval, type ApprovalDecision } from '@shared/mcp/approvals';
import { StreamCancelled, isCancellation, type ProviderToolCall } from '@shared/providers/types';
import type { ApprovalChoice, ApprovalRequest, ChatEvent, InstructionFields, RiskAction, ToolInvocation } from '@shared/types';
import { streamLangChainTurn, type ModelTurnInput, type ModelTurnMessage } from './chat-model';
import type { NodeSqliteSaver } from './checkpoint-sqlite';
import type { RuntimeTool } from './runtime-tool';

const RUNS = new Map<string, GraphDeps>();

export interface GraphParticipant {
  id: string;
  name: string;
  appName: string;
  agentName: string;
  enterprise: InstructionFields;
  persona: InstructionFields;
  user: InstructionFields;
  room?: string;
  risk?: string;
  skillIds: string[];
  skills: string;
}

export interface GraphDeps {
  provider: ModelTurnInput['provider'];
  model: string;
  temperature?: number;
  reasoningEffort?: ModelTurnInput['reasoningEffort'];
  showReasoning: boolean;
  apiKey?: string;
  baseUrl?: string;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now: () => number;
  emit: (event: ChatEvent) => void;
  requestApproval: (request: ApprovalRequest) => Promise<ApprovalChoice>;
  rememberAlways: (serverId: string, toolName: string) => void;
  tokenForServer: (serverId: string) => Promise<string>;
  callTool: (tool: RuntimeTool, args: unknown, accessToken: string | undefined) => Promise<string>;
  visibleTools?: (tools: RuntimeTool[], participant: GraphParticipant) => RuntimeTool[];
  gateTool?: (tool: RuntimeTool, participant: GraphParticipant | undefined) => string | null;
  recordAdminAction?: (agentId: string | null, action: string, detail: string) => void;
  persistMessage: (message: {
    id: string;
    content: string;
    reasoning: string;
    reasoningMs: number | null;
    authorId: string;
    authorName: string;
  }) => void;
  persistTool: (tool: ToolInvocation) => void;
}

const AgentState = Annotation.Root({
  messages: Annotation<ModelTurnMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  participants: Annotation<GraphParticipant[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  agentIndex: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  availableTools: Annotation<RuntimeTool[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  riskAction: Annotation<RiskAction>({
    reducer: (_left, right) => right,
    default: () => 'allow',
  }),
  remembered: Annotation<Record<string, 'always' | 'deny'>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  rounds: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  toolIndex: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  activeMessageId: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  maxRounds: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 4,
  }),
  conversationId: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  finalText: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  cancelled: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false,
  }),
});

type AgentStateType = typeof AgentState.State;

export function compileAgentGraph(checkpointer: NodeSqliteSaver) {
  return new StateGraph(AgentState)
    .addNode('model', modelNode)
    .addNode('tools', toolsNode)
    .addNode('next', advanceAgent)
    .addEdge(START, 'model')
    .addConditionalEdges('model', afterModel, ['tools', 'next', END])
    .addConditionalEdges('tools', afterTools, ['model', 'tools', 'next', END])
    .addEdge('next', 'model')
    .compile({ checkpointer });
}

export type AgentGraph = ReturnType<typeof compileAgentGraph>;

export function bindGraphRun(runId: string, deps: GraphDeps): void {
  RUNS.set(runId, deps);
}

export function releaseGraphRun(runId: string): void {
  RUNS.delete(runId);
}

function depsOf(config: RunnableConfig): GraphDeps {
  const runId = config.configurable?.run_id;
  const deps = typeof runId === 'string' ? RUNS.get(runId) : undefined;
  if (!deps) throw new Error('This graph run is missing its enterprise bindings.');
  return deps;
}

function publish(event: ChatEvent, deps: GraphDeps, config: RunnableConfig): void {
  const sink = config as RunnableConfig & { writer?: (chunk: ChatEvent) => void };
  const write = sink?.writer ?? (config?.configurable?.writer as ((chunk: ChatEvent) => void) | undefined);
  write?.(event);
  deps.emit(event);
}

async function modelNode(state: AgentStateType, config: RunnableConfig): Promise<Partial<AgentStateType>> {
  const deps = depsOf(config);
  const participant = state.participants[state.agentIndex];
  if (!participant) return { cancelled: true };
  const messageId = randomId();
  const started = deps.now();
  const elapsed = () => deps.now() - started;
  publish(
    {
      type: 'assistant-start',
      conversationId: state.conversationId,
      messageId,
      authorId: participant.id,
      authorName: participant.name,
    },
    deps,
    config,
  );
  publish(
    {
      type: 'assistant-phase',
      conversationId: state.conversationId,
      messageId,
      phase: 'thinking',
      elapsedMs: 0,
    },
    deps,
    config,
  );
  const composed = composeInstructions({
    branding: { appName: participant.appName, agentName: participant.agentName },
    enterprise: participant.enterprise,
    persona: participant.persona,
    user: participant.user,
    room: participant.room,
    risk: participant.risk,
  });
  const system = participant.skills ? `${composed}\n\n${participant.skills}` : composed;
  const visible = deps.visibleTools?.(state.availableTools, participant) ?? state.availableTools;
  let content = '';
  let reasoning = '';
  let answered = false;
  let cancelled = false;
  let toolCalls: ProviderToolCall[] = [];
  try {
    const result = await streamLangChainTurn({
      provider: deps.provider,
      model: deps.model,
      system,
      messages: state.messages,
      tools: visible,
      temperature: deps.temperature,
      reasoningEffort: deps.reasoningEffort,
      showReasoning: deps.showReasoning,
      apiKey: deps.apiKey,
      baseUrl: deps.baseUrl,
      delayMs: deps.delayMs,
      fetchImpl: deps.fetchImpl,
      signal: deps.signal,
      onChunk: (chunk) => {
        if (chunk.type === 'reasoning') {
          if (!deps.showReasoning) return;
          reasoning += chunk.delta;
          publish(
            { type: 'assistant-reasoning', conversationId: state.conversationId, messageId, delta: chunk.delta },
            deps,
            config,
          );
          return;
        }
        if (!answered) {
          answered = true;
          publish(
            {
              type: 'assistant-phase',
              conversationId: state.conversationId,
              messageId,
              phase: 'answering',
              elapsedMs: elapsed(),
            },
            deps,
            config,
          );
        }
        content += chunk.delta;
        publish({ type: 'assistant-delta', conversationId: state.conversationId, messageId, delta: chunk.delta }, deps, config);
      },
    });
    content = result.content || content;
    toolCalls = result.toolCalls;
  } catch (error) {
    if (!isCancellation(error)) throw error;
    cancelled = true;
  }
  const reasoningMs = elapsed();
  deps.persistMessage({
    id: messageId,
    content,
    reasoning: deps.showReasoning ? reasoning : '',
    reasoningMs: deps.showReasoning ? reasoningMs : null,
    authorId: participant.id,
    authorName: participant.name,
  });
  publish(
    {
      type: 'assistant-phase',
      conversationId: state.conversationId,
      messageId,
      phase: cancelled ? 'cancelled' : 'done',
      elapsedMs: reasoningMs,
    },
    deps,
    config,
  );
  publish({ type: 'assistant-done', conversationId: state.conversationId, messageId }, deps, config);
  const assistant: ModelTurnMessage = {
    role: 'assistant',
    content,
    toolCalls,
  };
  return {
    messages: [assistant],
    rounds: state.rounds + 1,
    toolIndex: 0,
    activeMessageId: messageId,
    finalText: content,
    cancelled,
    availableTools: visible,
  };
}

async function toolsNode(state: AgentStateType, config: RunnableConfig): Promise<Partial<AgentStateType>> {
  const deps = depsOf(config);
  const calls = latestToolCalls(state);
  const call = calls[state.toolIndex];
  if (!call) return {};
  if (deps.signal?.aborted) return { cancelled: true };
  const messageId = state.activeMessageId;
  const invocationId = call.id || `call-${state.toolIndex}-${call.name}`;
  const tool = state.availableTools.find((item) => item.key === call.name);
  const remembered = { ...state.remembered };
  if (!tool) {
    const denied = invocation(invocationId, messageId, {
      serverId: 'unknown',
      serverName: 'unknown',
      toolName: call.name,
      args: call.arguments,
      result: 'That tool is not connected.',
      status: 'denied',
      approval: 'automatic',
    });
    deps.persistTool(denied);
    publish({ type: 'tool', conversationId: state.conversationId, messageId, tool: denied }, deps, config);
    return {
      messages: [{ role: 'tool', toolCallId: invocationId, content: denied.result ?? '' }],
      toolIndex: state.toolIndex + 1,
    };
  }
  const participant = state.participants[state.agentIndex];
  const gated = deps.gateTool?.(tool, participant);
  if (gated) {
    const denied = invocation(invocationId, messageId, {
      serverId: tool.serverId,
      serverName: tool.serverName,
      toolName: tool.name,
      args: parseToolArgs(call.arguments),
      result: gated,
      status: 'denied',
      approval: 'automatic',
    });
    deps.persistTool(denied);
    publish({ type: 'tool', conversationId: state.conversationId, messageId, tool: denied }, deps, config);
    return {
      messages: [{ role: 'tool', toolCallId: invocationId, content: gated }],
      toolIndex: state.toolIndex + 1,
    };
  }
  const args = parseToolArgs(call.arguments);
  const preferenceKey = `${tool.serverId}\0${tool.name}`;
  const preview = previewApproval({
    riskAction: state.riskAction,
    readOnlyHint: tool.readOnlyHint,
    remembered: remembered[preferenceKey],
  });
  const live = (status: ToolInvocation['status'], result: string | null = null, approval: ToolInvocation['approval'] = null): ToolInvocation =>
    invocation(invocationId, messageId, {
      serverId: tool.serverId,
      serverName: tool.serverName,
      toolName: tool.name,
      args,
      result,
      status,
      approval,
    });
  publish({ type: 'tool', conversationId: state.conversationId, messageId, tool: live('calling') }, deps, config);
  let outcome: ApprovalDecision;
  if (preview.type === 'prompt') {
    publish({ type: 'tool', conversationId: state.conversationId, messageId, tool: live('approval') }, deps, config);
    const choice = interrupt<ApprovalRequest, ApprovalChoice>({
      id: invocationId,
      conversationId: state.conversationId,
      serverId: tool.serverId,
      serverName: tool.serverName,
      toolName: tool.name,
      argumentsText: JSON.stringify(args, null, 2),
      readOnlyHint: tool.readOnlyHint,
      riskAction: state.riskAction,
      allowAlways: preview.allowAlways,
    });
    if (deps.signal?.aborted) {
      const stopped = live('denied', 'Stopped.', 'deny');
      deps.persistTool(stopped);
      publish({ type: 'tool', conversationId: state.conversationId, messageId, tool: stopped }, deps, config);
      return { cancelled: true, remembered };
    }
    if (choice === 'always' && preview.allowAlways) {
      deps.rememberAlways(tool.serverId, tool.name);
      remembered[preferenceKey] = 'always';
    }
    outcome = choiceFromUser(choice, preview.allowAlways);
  } else {
    outcome = preview;
  }
  if (outcome.type === 'deny') {
    const denied = live('denied', outcome.reason, outcome.automatic ? 'automatic' : 'deny');
    deps.persistTool(denied);
    publish({ type: 'tool', conversationId: state.conversationId, messageId, tool: denied }, deps, config);
    return {
      messages: [{ role: 'tool', toolCallId: invocationId, content: outcome.reason }],
      remembered,
      toolIndex: state.toolIndex + 1,
    };
  }
  publish({ type: 'tool', conversationId: state.conversationId, messageId, tool: live('running') }, deps, config);
  let resultText: string;
  let status: ToolInvocation['status'] = 'done';
  try {
    if (deps.signal?.aborted) throw new StreamCancelled();
    const accessToken = await deps.tokenForServer(tool.serverId);
    resultText = await deps.callTool(tool, args, accessToken || undefined);
    if (deps.recordAdminAction && tool.serverId) {
      deps.recordAdminAction(participant?.id ?? null, `tool:${tool.serverId}/${tool.name}`, JSON.stringify(args));
    }
  } catch (error) {
    if (isCancellation(error)) {
      const stopped = live('denied', 'Stopped.', outcome.persistence);
      deps.persistTool(stopped);
      publish({ type: 'tool', conversationId: state.conversationId, messageId, tool: stopped }, deps, config);
      return { cancelled: true, remembered };
    }
    status = 'error';
    resultText = error instanceof Error ? error.message : String(error);
  }
  const done = live(status, resultText, outcome.persistence);
  deps.persistTool(done);
  publish({ type: 'tool', conversationId: state.conversationId, messageId, tool: done }, deps, config);
  return {
    messages: [{ role: 'tool', toolCallId: invocationId, content: resultText }],
    remembered,
    toolIndex: state.toolIndex + 1,
  };
}

function invocation(id: string, messageId: string, fields: Omit<ToolInvocation, 'id' | 'messageId'>): ToolInvocation {
  return { id, messageId, ...fields };
}

function latestToolCalls(state: AgentStateType): ProviderToolCall[] {
  const assistant = [...state.messages].reverse().find((message) => message.role === 'assistant');
  return assistant?.toolCalls ?? [];
}

function parseToolArgs(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { raw };
  }
}

function advanceAgent(state: AgentStateType): Partial<AgentStateType> {
  return { agentIndex: state.agentIndex + 1, rounds: 0 };
}

function afterModel(state: AgentStateType): 'tools' | 'next' | typeof END {
  if (state.cancelled) return END;
  if (latestToolCalls(state).length > 0) return 'tools';
  if (state.agentIndex + 1 < state.participants.length) return 'next';
  return END;
}

function afterTools(state: AgentStateType): 'model' | 'tools' | 'next' | typeof END {
  if (state.cancelled) return END;
  if (state.toolIndex < latestToolCalls(state).length) return 'tools';
  if (state.rounds < state.maxRounds) return 'model';
  if (state.agentIndex + 1 < state.participants.length) return 'next';
  return END;
}

export interface AgentRunInput {
  graph: AgentGraph;
  checkpointer: NodeSqliteSaver;
  threadId: string;
  runId: string;
  deps: GraphDeps;
  initial: Partial<AgentStateType>;
}

export async function runAgentGraph(input: AgentRunInput): Promise<string> {
  bindGraphRun(input.runId, input.deps);
  const config = {
    configurable: { thread_id: input.threadId, run_id: input.runId },
    streamMode: ['messages', 'updates', 'custom'] as Array<'messages' | 'updates' | 'custom'>,
    recursionLimit: 40,
  };
  let pending = input.initial as Parameters<AgentGraph['stream']>[0];
  let finalText = '';
  try {
    for (;;) {
      let interruptValue: unknown;
      try {
        const stream = await input.graph.stream(pending, config);
        for await (const part of stream) {
          const data = streamData(part);
          const found = interruptFromUpdate(data);
          if (found !== undefined) interruptValue = found;
          if (data && typeof data === 'object' && 'finalText' in data && typeof data.finalText === 'string') {
            finalText = data.finalText;
          }
        }
      } catch (error) {
        if (!isGraphInterrupt(error)) throw error;
      }
      if (interruptValue === undefined) {
        const snapshot = await input.graph.getState({ configurable: config.configurable });
        interruptValue = snapshot.tasks.flatMap((task) => task.interrupts ?? []).at(0)?.value;
        if (typeof snapshot.values.finalText === 'string') finalText = snapshot.values.finalText;
      }
      if (interruptValue === undefined) return finalText;
      const request = interruptValue as ApprovalRequest;
      let choice: ApprovalChoice = 'deny';
      if (!input.deps.signal?.aborted) {
        try {
          choice = await withSignal(input.deps.requestApproval(request), input.deps.signal);
        } catch (error) {
          if (!isCancellation(error)) throw error;
          choice = 'deny';
        }
      }
      pending = new Command({ resume: choice }) as Parameters<AgentGraph['stream']>[0];
    }
  } finally {
    releaseGraphRun(input.runId);
    await input.checkpointer.deleteThread(input.threadId).catch(() => undefined);
  }
}

function streamData(part: unknown): unknown {
  if (Array.isArray(part) && part.length === 2) return part[1];
  return part;
}

function interruptFromUpdate(data: unknown): unknown {
  if (!data || typeof data !== 'object' || !('__interrupt__' in data)) return undefined;
  const list = (data as { __interrupt__?: { value?: unknown }[] }).__interrupt__;
  return list?.[0]?.value;
}

function isGraphInterrupt(error: unknown): boolean {
  return error instanceof GraphInterrupt || (error instanceof Error && error.name === 'GraphInterrupt');
}

function withSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new StreamCancelled());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new StreamCancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
