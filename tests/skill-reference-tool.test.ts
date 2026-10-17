import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessageChunk } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { compileAgentGraph, runAgentGraph, type GraphDeps } from '../src/main/agent-graph';
import { collectStreamedToolCalls, streamLangChainTurn } from '../src/main/chat-model';
import { openCheckpointer } from '../src/main/checkpoint-sqlite';
import {
  loadSkillBundle,
  resolveSkillBundle,
  skillReferenceToolFields,
} from '../src/main/skill-bundle';
import type { RuntimeTool } from '../src/main/runtime-tool';
import type { InstructionFields } from '../src/shared/types';

const quirks = 'references/ea-api-operational-quirks.md';

function skillTool(): RuntimeTool {
  const root = resolveSkillBundle(process.cwd());
  const bundle = loadSkillBundle(root ?? '');
  const fields = skillReferenceToolFields(bundle.files);
  return {
    key: 'skill__read_skill_reference',
    serverId: 'skill',
    serverName: 'PingOne skill',
    name: 'read_skill_reference',
    description: fields.description,
    inputSchema: fields.inputSchema,
    readOnlyHint: true,
    strict: fields.strict,
  };
}

function echoTool(): RuntimeTool {
  return {
    key: 'echo__echo',
    serverId: 'echo',
    serverName: 'Local echo',
    name: 'echo',
    description: 'Echo a message',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
    readOnlyHint: true,
  };
}

function sse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function functionCallEvents(argument: string): unknown[] {
  const midpoint = Math.max(1, Math.floor(argument.length / 2));
  return [
    { type: 'response.created', response: { id: 'resp_ref', model: 'gpt-5', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'fc_1',
        type: 'function_call',
        name: 'skill__read_skill_reference',
        call_id: 'call_ref',
        arguments: '',
      },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: 'fc_1',
      delta: argument.slice(0, midpoint),
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: 'fc_1',
      delta: argument.slice(midpoint),
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_ref',
        model: 'gpt-5',
        output: [],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    },
  ];
}

describe('skill reference tool arguments', () => {
  it('merges nameless Responses argument deltas instead of keeping {}', () => {
    const argument = JSON.stringify({ name: quirks });
    const midpoint = Math.floor(argument.length / 2);
    const first = new AIMessageChunk({
      content: '',
      tool_call_chunks: [
        {
          type: 'tool_call_chunk',
          name: 'skill__read_skill_reference',
          args: '',
          id: 'call_ref',
          index: 0,
        },
      ],
    });
    const second = new AIMessageChunk({
      content: '',
      tool_call_chunks: [{ type: 'tool_call_chunk', args: argument.slice(0, midpoint), index: 0 }],
    });
    const third = new AIMessageChunk({
      content: '',
      tool_call_chunks: [{ type: 'tool_call_chunk', args: argument.slice(midpoint), index: 0 }],
    });
    expect(first.tool_calls?.[0]?.args).toEqual({});
    const calls = collectStreamedToolCalls([first, second, third]);
    expect(calls).toEqual([
      {
        id: 'call_ref',
        name: 'skill__read_skill_reference',
        arguments: argument,
      },
    ]);
    const formed = new AIMessageChunk({
      content: '',
      tool_calls: [{ id: 'call_echo', name: 'echo__echo', args: { message: 'hello' }, type: 'tool_call' }],
    });
    expect(collectStreamedToolCalls([formed])).toEqual([
      { id: 'call_echo', name: 'echo__echo', arguments: JSON.stringify({ message: 'hello' }) },
    ]);
  });

  it('logs raw streamed tool-call args when AGENT_DEBUG is 1', () => {
    const previous = process.env.AGENT_DEBUG;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.AGENT_DEBUG = '1';
    try {
      collectStreamedToolCalls([
        new AIMessageChunk({
          content: '',
          tool_call_chunks: [
            { type: 'tool_call_chunk', name: 'skill__read_skill_reference', args: '', id: 'call_ref', index: 0 },
          ],
        }),
      ]);
      expect(spy).toHaveBeenCalled();
      expect(String(spy.mock.calls[0]?.[0])).toContain('raw tool-call args');
      expect(String(spy.mock.calls[0]?.[0])).toContain('call_ref');
    } finally {
      if (previous === undefined) delete process.env.AGENT_DEBUG;
      else process.env.AGENT_DEBUG = previous;
      spy.mockRestore();
    }
  });

  it('sends a required enum and strict true on the OpenAI Responses payload', async () => {
    let request: Record<string, unknown> = {};
    const tool = skillTool();
    await streamLangChainTurn({
      provider: 'openai',
      model: 'gpt-5',
      system: 'Read the skill reference first.',
      messages: [{ role: 'user', content: 'read the quirks reference' }],
      tools: [tool, echoTool()],
      showReasoning: true,
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      onChunk: () => undefined,
      fetchImpl: async (_url, init) => {
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([
          { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5', output: [] } },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: 'Ok' },
          {
            type: 'response.completed',
            response: { id: 'resp_1', model: 'gpt-5', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
          },
        ]);
      },
    });
    const tools = request.tools as {
      name?: string;
      strict?: boolean | null;
      parameters?: {
        required?: string[];
        additionalProperties?: boolean;
        properties?: { name?: { enum?: string[] } };
      };
    }[];
    const skill = tools.find((item) => item.name === 'skill__read_skill_reference');
    const echo = tools.find((item) => item.name === 'echo__echo');
    expect(skill?.strict).toBe(true);
    expect(skill?.parameters?.required).toContain('name');
    expect(skill?.parameters?.additionalProperties).toBe(false);
    expect(skill?.parameters?.properties?.name?.enum).toContain(quirks);
    expect(skill?.parameters?.properties?.name?.enum).toContain('scripts/walk_policy_tree.py');
    expect(echo?.strict).not.toBe(true);
  });

  it('parses a streamed Responses function call into the tool node arguments', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'skill-ref-stream-'));
    const checkpointer = openCheckpointer(join(directory, 'turns.sqlite'));
    const graph = compileAgentGraph(checkpointer);
    const argument = JSON.stringify({ name: quirks });
    let request: Record<string, unknown> = {};
    let calls = 0;
    const seen: unknown[] = [];
    const blank: InstructionFields = {
      persona: '',
      communicationStyle: '',
      autonomy: '',
      safety: '',
      untrustedContent: '',
    };
    const deps: GraphDeps = {
      provider: 'openai',
      model: 'gpt-5',
      showReasoning: true,
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      now: () => 1_000,
      emit: () => undefined,
      requestApproval: async () => 'deny',
      rememberAlways: () => undefined,
      tokenForServer: async () => '',
      callTool: async (_tool, args) => {
        seen.push(args);
        return 'reference text';
      },
      persistMessage: () => undefined,
      persistTool: () => undefined,
      fetchImpl: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (calls === 1) request = body;
        if (calls === 1) return sse(functionCallEvents(argument));
        return sse([
          { type: 'response.created', response: { id: 'resp_2', model: 'gpt-5', output: [] } },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_2', delta: 'Done' },
          {
            type: 'response.completed',
            response: { id: 'resp_2', model: 'gpt-5', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
          },
        ]);
      },
    };
    try {
      await runAgentGraph({
        graph,
        checkpointer,
        threadId: 'skill-stream',
        runId: 'skill-stream-run',
        deps,
        initial: {
          conversationId: 'c-skill-stream',
          participants: [
            {
              id: 'agent-1',
              name: 'Northstar',
              appName: 'Northstar',
              agentName: 'Northstar',
              enterprise: blank,
              persona: blank,
              user: blank,
              skillIds: ['pingone'],
              skills: '',
              risk: 'Risk level: LOW.\nPolicy action: allow.',
            },
          ],
          messages: [{ role: 'user', content: 'read the quirks reference' }],
          availableTools: [skillTool()],
          riskAction: 'allow',
          remembered: { 'skill\0read_skill_reference': 'always' },
        },
      });
    } finally {
      checkpointer.close();
    }
    const tools = request.tools as { name?: string; strict?: boolean | null }[];
    expect(tools.some((tool) => tool.name === 'skill__read_skill_reference' && tool.strict === true)).toBe(true);
    expect(seen).toEqual([{ name: quirks }]);
  });
});
