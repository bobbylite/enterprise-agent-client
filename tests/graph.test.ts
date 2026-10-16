import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { bindGraphRun, compileAgentGraph, releaseGraphRun, runAgentGraph, type GraphDeps, type GraphParticipant } from '../src/main/agent-graph';
import { openCheckpointer } from '../src/main/checkpoint-sqlite';
import { AIMessageChunk } from '@langchain/core/messages';
import { anthropicTurnFields, openAiTurnFields, readModelChunk } from '../src/main/chat-model';
import type { RuntimeTool } from '../src/main/runtime-tool';
import { skillReferenceDenied } from '../src/main/skill-bundle';
import type { ApprovalRequest, ChatEvent, InstructionFields } from '../src/shared/types';

const blank: InstructionFields = {
  persona: '',
  communicationStyle: '',
  autonomy: '',
  safety: '',
  untrustedContent: '',
};

function participant(patch?: Partial<GraphParticipant>): GraphParticipant {
  return {
    id: 'agent-1',
    name: 'Northstar',
    appName: 'Northstar',
    agentName: 'Northstar',
    enterprise: { ...blank, persona: 'Locked enterprise policy: never reveal secrets.' },
    persona: { ...blank, persona: 'Be a careful assistant.' },
    user: { ...blank, communicationStyle: 'Use short sentences.' },
    risk: 'Session risk context (authoritative for this sign-in):\nRisk level: HIGH.\nPolicy action: block.',
    skillIds: [],
    skills: '',
    ...patch,
  };
}

function echoTool(readOnlyHint = true): RuntimeTool {
  return {
    key: 'echo__echo',
    serverId: 'echo',
    serverName: 'Local echo',
    name: 'echo',
    description: 'Echo',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
    readOnlyHint,
  };
}

function deps(patch?: Partial<GraphDeps>): { deps: GraphDeps; events: ChatEvent[]; calls: { token: string[]; tool: string[] } } {
  const events: ChatEvent[] = [];
  const calls = { token: [] as string[], tool: [] as string[] };
  const base: GraphDeps = {
    provider: 'mock',
    model: 'mock',
    showReasoning: true,
    delayMs: 0,
    now: () => 1_000,
    signal: undefined,
    emit: (event) => events.push(event),
    requestApproval: async () => 'once',
    rememberAlways: () => undefined,
    tokenForServer: async (serverId) => {
      calls.token.push(serverId);
      return 'exchanged-token';
    },
    callTool: async (tool, args, accessToken) => {
      calls.tool.push(`${tool.name}:${accessToken ?? ''}:${JSON.stringify(args)}`);
      return 'echoed';
    },
    persistMessage: () => undefined,
    persistTool: () => undefined,
  };
  return { deps: { ...base, ...patch }, events, calls };
}

describe('LangGraph runtime', () => {
  it('assembles the locked policy inside the model node and streams through custom mode', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'graph-prompt-'));
    const checkpointer = openCheckpointer(join(directory, 'turns.sqlite'));
    const graph = compileAgentGraph(checkpointer);
    let system = '';
    const { deps: bound, events } = deps({
      provider: 'generic',
      model: 'default',
      baseUrl: 'https://llm.example/generate',
      fetchImpl: async (_url, init) => {
        system = JSON.parse(String(init?.body)).system as string;
        return new Response(JSON.stringify({ content: 'Acknowledged.', reasoning: 'Looking at policy.' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const runId = 'prompt-run';
    bindGraphRun(runId, bound);
    const custom: ChatEvent[] = [];
    try {
      const stream = await graph.stream(
        {
          conversationId: 'c1',
          participants: [participant({ risk: 'Risk level: LOW.\nPolicy action: allow.', skills: 'Skill: PingOne\nUse the worker token.' })],
          messages: [{ role: 'user', content: 'hello' }],
          availableTools: [],
        },
        { configurable: { thread_id: 'prompt-thread', run_id: runId }, streamMode: ['custom', 'updates', 'messages'] },
      );
      for await (const part of stream) {
        if (Array.isArray(part) && part[0] === 'custom') custom.push(part[1] as ChatEvent);
      }
    } finally {
      releaseGraphRun(runId);
      checkpointer.close();
    }
    expect(system).toContain('Enterprise policy (locked)');
    expect(system).toContain('never reveal secrets');
    expect(system).toContain('Be a careful assistant.');
    expect(system).toContain('Use short sentences.');
    expect(system).toContain('Policy action: allow.');
    expect(custom.some((event) => event.type === 'assistant-delta')).toBe(true);
    expect(events.some((event) => event.type === 'assistant-reasoning')).toBe(true);
    expect(system.indexOf('Enterprise policy (locked)')).toBeLessThan(system.indexOf('Agent persona'));
    expect(system).toContain('Skill: PingOne');
  });

  it('denies a PingOne tool in the tool node even when it is still listed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'graph-pingone-'));
    const checkpointer = openCheckpointer(join(directory, 'turns.sqlite'));
    const graph = compileAgentGraph(checkpointer);
    const seen: string[] = [];
    const { deps: bound, calls } = deps({
      gateTool: () => 'PingOne tools are limited to the Administrator group.',
      persistTool: (tool) => {
        seen.push(`${tool.status}:${tool.result ?? ''}`);
      },
    });
    try {
      await runAgentGraph({
        graph,
        checkpointer,
        threadId: 'pingone-thread',
        runId: 'pingone-run',
        deps: bound,
        initial: {
          conversationId: 'c-pingone',
          participants: [participant({ skillIds: [], skills: '' })],
          messages: [{ role: 'user', content: 'echo hello' }],
          availableTools: [
            {
              key: 'pingone__echo',
              serverId: 'pingone',
              serverName: 'PingOne',
              name: 'createPolicy',
              description: 'Create a policy',
              inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
              readOnlyHint: false,
            },
          ],
          riskAction: 'allow',
        },
      });
      expect(calls.token).toEqual([]);
      expect(calls.tool).toEqual([]);
      expect(seen).toContain('denied:PingOne tools are limited to the Administrator group.');
    } finally {
      checkpointer.close();
    }
  });

  it('denies read_skill_reference in the tool node for a non-admin even when it is listed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'graph-skill-ref-'));
    const checkpointer = openCheckpointer(join(directory, 'turns.sqlite'));
    const graph = compileAgentGraph(checkpointer);
    const seen: string[] = [];
    const { deps: bound, calls } = deps({
      provider: 'generic',
      model: 'generic-1',
      baseUrl: 'https://llm.example/generate',
      gateTool: (tool, participant) =>
        skillReferenceDenied({
          serverId: tool.serverId,
          name: tool.name,
          mcpServerId: 'pingone',
          admin: false,
          adminGroup: 'Administrator',
          pingoneTools: true,
          skillIds: participant?.skillIds ?? ['pingone'],
        }),
      persistTool: (tool) => {
        seen.push(`${tool.status}:${tool.result ?? ''}`);
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages?: { role: string }[] };
        const sawTool = body.messages?.some((message) => message.role === 'tool') ?? false;
        if (!sawTool) {
          return new Response(
            JSON.stringify({
              content: '',
              tool_calls: [
                {
                  id: 'call-ref',
                  name: 'skill__read_skill_reference',
                  arguments: JSON.stringify({ name: 'references/ea-api-operational-quirks.md' }),
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ content: 'Stopped.' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    try {
      await runAgentGraph({
        graph,
        checkpointer,
        threadId: 'skill-ref-thread',
        runId: 'skill-ref-run',
        deps: bound,
        initial: {
          conversationId: 'c-skill-ref',
          participants: [participant({ skillIds: ['pingone'], skills: '' })],
          messages: [{ role: 'user', content: 'read the authorize reference' }],
          availableTools: [
            {
              key: 'skill__read_skill_reference',
              serverId: 'skill',
              serverName: 'PingOne skill',
              name: 'read_skill_reference',
              description: 'Read a skill reference',
              inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
              readOnlyHint: true,
            },
          ],
          riskAction: 'allow',
        },
      });
      expect(calls.token).toEqual([]);
      expect(calls.tool).toEqual([]);
      expect(seen).toContain('denied:PingOne tools are limited to the Administrator group.');
    } finally {
      checkpointer.close();
    }
  });

  it('blocks a tool inside the graph without exchanging a token', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'graph-block-'));
    const checkpointer = openCheckpointer(join(directory, 'turns.sqlite'));
    const graph = compileAgentGraph(checkpointer);
    let asked = false;
    const { deps: bound, calls } = deps({
      requestApproval: async () => {
        asked = true;
        return 'once';
      },
    });
    try {
      const output = await runAgentGraph({
        graph,
        checkpointer,
        threadId: 'block-thread',
        runId: 'block-run',
        deps: bound,
        initial: {
          conversationId: 'c-block',
          participants: [participant()],
          messages: [{ role: 'user', content: 'echo hello' }],
          availableTools: [echoTool()],
          riskAction: 'block',
        },
      });
      expect(asked).toBe(false);
      expect(calls.token).toEqual([]);
      expect(calls.tool).toEqual([]);
      expect(output).toContain('blocked');
    } finally {
      checkpointer.close();
    }
  });

  it('denies a write tool while the session is read-only', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'graph-ro-'));
    const checkpointer = openCheckpointer(join(directory, 'turns.sqlite'));
    const graph = compileAgentGraph(checkpointer);
    const { deps: bound, calls } = deps();
    try {
      await runAgentGraph({
        graph,
        checkpointer,
        threadId: 'ro-thread',
        runId: 'ro-run',
        deps: bound,
        initial: {
          conversationId: 'c-ro',
          participants: [participant({ risk: 'Risk level: HIGH.\nPolicy action: read_only.' })],
          messages: [{ role: 'user', content: 'echo hello' }],
          availableTools: [echoTool(false)],
          riskAction: 'read_only',
        },
      });
      expect(calls.token).toEqual([]);
      expect(calls.tool).toEqual([]);
    } finally {
      checkpointer.close();
    }
  });

  it('resumes an approval from a new graph on the same SQLite checkpointer and injects the exchanged token', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'graph-resume-'));
    const path = join(directory, 'turns.sqlite');
    const first = openCheckpointer(path);
    const graph = compileAgentGraph(first);
    const { deps: bound, calls, events } = deps();
    const runId = 'resume-run';
    bindGraphRun(runId, bound);
    const config = { configurable: { thread_id: 'resume-thread', run_id: runId }, streamMode: ['updates', 'custom'] as ['updates', 'custom'] };
    try {
      const stream = await graph.stream(
        {
          conversationId: 'c-resume',
          participants: [participant({ risk: 'Risk level: LOW.\nPolicy action: allow.' })],
          messages: [{ role: 'user', content: 'echo hello' }],
          availableTools: [echoTool()],
          riskAction: 'allow',
        },
        config,
      );
      let approval: ApprovalRequest | undefined;
      for await (const part of stream) {
        const data = Array.isArray(part) ? part[1] : part;
        if (data && typeof data === 'object' && '__interrupt__' in data) {
          approval = (data as { __interrupt__: { value: ApprovalRequest }[] }).__interrupt__[0]?.value;
        }
      }
      expect(approval?.allowAlways).toBe(true);
      expect(approval?.toolName).toBe('echo');
      expect(calls.token).toEqual([]);
      expect(events.some((event) => event.type === 'tool' && event.tool.status === 'approval')).toBe(true);
      first.close();

      const second = openCheckpointer(path);
      const resumed = compileAgentGraph(second);
      try {
        const follow = await resumed.stream(new Command({ resume: 'once' }), config);
        for await (const _part of follow) {
          // Drain the resumed run.
        }
      } finally {
        second.close();
      }
      expect(calls.token).toEqual(['echo']);
      expect(calls.tool[0]).toContain('exchanged-token');
      expect(calls.tool[0]).toContain('hello');
    } finally {
      releaseGraphRun(runId);
    }
  });

  it('does not execute a tool at medium risk even when the action would approve every call', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'graph-medium-'));
    const checkpointer = openCheckpointer(join(directory, 'turns.sqlite'));
    const graph = compileAgentGraph(checkpointer);
    let asked = false;
    const { deps: bound, calls } = deps({
      requestApproval: async () => {
        asked = true;
        return 'once';
      },
    });
    try {
      await runAgentGraph({
        graph,
        checkpointer,
        threadId: 'medium-thread',
        runId: 'medium-run',
        deps: bound,
        initial: {
          conversationId: 'c-medium',
          participants: [participant({ risk: 'Risk level: MEDIUM.\nPolicy action: restrict_tools.' })],
          messages: [{ role: 'user', content: 'echo hello' }],
          availableTools: [echoTool(false)],
          riskAction: 'restrict_tools',
          riskLevel: 'MEDIUM',
        },
      });
      expect(asked).toBe(false);
      expect(calls.token).toEqual([]);
      expect(calls.tool).toEqual([]);
    } finally {
      checkpointer.close();
    }
  });

  it('does not remember an always choice while tools are restricted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'graph-restrict-'));
    const checkpointer = openCheckpointer(join(directory, 'turns.sqlite'));
    const graph = compileAgentGraph(checkpointer);
    let remembered = false;
    let allowAlways = true;
    const { deps: bound, calls } = deps({
      requestApproval: async (request) => {
        allowAlways = request.allowAlways;
        return 'always';
      },
      rememberAlways: () => {
        remembered = true;
      },
    });
    try {
      await runAgentGraph({
        graph,
        checkpointer,
        threadId: 'restrict-thread',
        runId: 'restrict-run',
        deps: bound,
        initial: {
          conversationId: 'c-restrict',
          participants: [participant({ risk: 'Risk level: MEDIUM.\nPolicy action: restrict_tools.' })],
          messages: [{ role: 'user', content: 'echo hello' }],
          availableTools: [echoTool()],
          riskAction: 'restrict_tools',
        },
      });
      expect(allowAlways).toBe(false);
      expect(remembered).toBe(false);
      expect(calls.token).toEqual(['echo']);
    } finally {
      checkpointer.close();
    }
  });

  it('skips the approval interrupt when the tool was already allowed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'graph-always-'));
    const checkpointer = openCheckpointer(join(directory, 'turns.sqlite'));
    const graph = compileAgentGraph(checkpointer);
    let asked = false;
    const { deps: bound, calls } = deps({
      requestApproval: async () => {
        asked = true;
        return 'deny';
      },
    });
    try {
      await runAgentGraph({
        graph,
        checkpointer,
        threadId: 'always-thread',
        runId: 'always-run',
        deps: bound,
        initial: {
          conversationId: 'c-always',
          participants: [participant({ risk: 'Risk level: LOW.\nPolicy action: allow.' })],
          messages: [{ role: 'user', content: 'echo hello' }],
          availableTools: [echoTool()],
          riskAction: 'allow',
          remembered: { 'echo\0echo': 'always' },
        },
      });
      expect(asked).toBe(false);
      expect(calls.token).toEqual(['echo']);
    } finally {
      checkpointer.close();
    }
  });

  it('forwards Responses API reasoning summary deltas and still streams text', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'graph-reasoning-'));
    const checkpointer = openCheckpointer(join(directory, 'turns.sqlite'));
    const graph = compileAgentGraph(checkpointer);
    let request: Record<string, unknown> = {};
    const events = [
      { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5', output: [] } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'rs_1', type: 'reasoning', summary: [] },
      },
      {
        type: 'response.reasoning_summary_text.delta',
        summary_index: 0,
        output_index: 0,
        item_id: 'rs_1',
        delta: 'Looking',
      },
      {
        type: 'response.reasoning_summary_text.delta',
        summary_index: 0,
        output_index: 0,
        item_id: 'rs_1',
        delta: ' at policy.',
      },
      {
        type: 'response.output_text.delta',
        output_index: 1,
        content_index: 0,
        item_id: 'msg_1',
        delta: 'Hi',
      },
      {
        type: 'response.completed',
        response: { id: 'resp_1', model: 'gpt-5', output: [], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
      },
    ];
    const { deps: bound, events: chat } = deps({
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'test-key',
      showReasoning: true,
      baseUrl: 'https://llm.example/v1',
      fetchImpl: async (_url, init) => {
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    });
    try {
      await runAgentGraph({
        graph,
        checkpointer,
        threadId: 'reasoning-thread',
        runId: 'reasoning-run',
        deps: bound,
        initial: {
          conversationId: 'c-reasoning',
          participants: [participant({ risk: 'Risk level: LOW.\nPolicy action: allow.' })],
          messages: [{ role: 'user', content: 'hello' }],
          availableTools: [],
          riskAction: 'allow',
        },
      });
    } finally {
      checkpointer.close();
    }
    expect(request.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    const reasoning = chat
      .filter((event): event is Extract<ChatEvent, { type: 'assistant-reasoning' }> => event.type === 'assistant-reasoning')
      .map((event) => event.delta)
      .join('');
    const text = chat
      .filter((event): event is Extract<ChatEvent, { type: 'assistant-delta' }> => event.type === 'assistant-delta')
      .map((event) => event.delta)
      .join('');
    expect(reasoning).toBe('Looking at policy.');
    expect(text).toBe('Hi');
    expect(chat.some((event) => event.type === 'assistant-phase' && event.phase === 'thinking')).toBe(true);
    expect(chat.some((event) => event.type === 'assistant-phase' && event.phase === 'answering')).toBe(true);
    expect(readModelChunk(new AIMessageChunk({
      content: [{ type: 'text', text: 'Hi' }],
      additional_kwargs: {
        reasoning: { type: 'reasoning', summary: [{ text: 'Because ', type: 'summary_text' }, { text: 'it matters.', type: 'summary_text' }] },
      },
    }))).toEqual({ text: 'Hi', reasoning: 'Because it matters.' });
  });

  it('maps provider settings onto LangChain chat models', () => {
    const reasoning = openAiTurnFields({ model: 'gpt-5', reasoningEffort: 'medium', showReasoning: true, temperature: 0.4 });
    expect(reasoning.useResponsesApi).toBe(true);
    expect(reasoning.temperature).toBeUndefined();
    expect(reasoning.reasoning).toMatchObject({ effort: 'medium', summary: 'auto' });
    const quiet = openAiTurnFields({ model: 'gpt-5', reasoningEffort: 'low', showReasoning: false });
    expect(quiet.useResponsesApi).toBe(false);
    expect(quiet.reasoning).toMatchObject({ effort: 'low' });
    expect(quiet.reasoning).not.toHaveProperty('summary');
    const chat = openAiTurnFields({ model: 'gpt-4o', temperature: 0.2, showReasoning: true });
    expect(chat.useResponsesApi).toBe(false);
    expect(chat.temperature).toBe(0.2);
    const implicit = openAiTurnFields({ model: 'gpt-5', showReasoning: true, temperature: 0.4 });
    expect(implicit.useResponsesApi).toBe(true);
    expect(implicit.temperature).toBeUndefined();
    expect(implicit.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    const thinking = anthropicTurnFields({ model: 'claude-sonnet-4-5', showReasoning: true, temperature: 0.3 });
    expect(thinking.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(thinking.temperature).toBeUndefined();
    const plain = anthropicTurnFields({ model: 'claude-sonnet-4-5', showReasoning: false, temperature: 0.3 });
    expect(plain.thinking).toBeUndefined();
    expect(plain.temperature).toBe(0.3);
  });
});
