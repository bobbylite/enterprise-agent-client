import { Client, InsufficientScopeError, UnauthorizedError } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { SSEClientTransport, StreamableHTTPClientTransport, type AuthProvider } from '@modelcontextprotocol/client';
import { toolKey } from '@shared/mcp/approvals';
import { extensionProcessEnv } from '@shared/mcp/path';
import type { RuntimeTool } from './runtime-tool';

export interface McpConnectTarget {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command: string;
  args: string[];
  url: string;
  cwd: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  accessToken?: string;
  fetchImpl?: typeof fetch;
  allowUnauthorized?: boolean;
  refreshAccessToken?: () => Promise<string | undefined>;
}

interface LiveConnection {
  client: Client;
  close: () => Promise<void>;
  tools: RuntimeTool[];
  target: McpConnectTarget;
  accessToken?: string;
  tokenSlot: { current?: string };
}

export class McpHub {
  private readonly connections = new Map<string, LiveConnection>();
  private readonly errors = new Map<string, string>();

  constructor(
    private readonly clientInfo: { name: string; version: string },
    private readonly environment: {
      platform?: string;
      home?: string;
      onInsufficientScope?: (serverId: string, scope: string | undefined) => void;
    } = {},
  ) {}

  status(serverId: string): 'connected' | 'disconnected' | 'error' {
    if (this.connections.has(serverId)) return 'connected';
    if (this.errors.has(serverId)) return 'error';
    return 'disconnected';
  }

  error(serverId: string): string | undefined {
    return this.errors.get(serverId);
  }

  tools(serverId: string): RuntimeTool[] {
    return this.connections.get(serverId)?.tools ?? [];
  }

  allTools(): RuntimeTool[] {
    return [...this.connections.values()].flatMap((connection) => connection.tools);
  }

  async connect(target: McpConnectTarget): Promise<RuntimeTool[]> {
    await this.disconnect(target.id);
    this.errors.delete(target.id);
    try {
      const client = new Client(this.clientInfo);
      const tokenSlot = { current: target.accessToken };
      const timeout = target.timeoutMs ? { timeout: target.timeoutMs } : undefined;
      if (target.transport === 'stdio') {
        const env = extensionProcessEnv({
          platform: this.environment.platform ?? process.platform,
          home: this.environment.home ?? process.env.HOME,
          inherited: getDefaultEnvironment(),
          extra: target.env,
          accessToken: target.accessToken,
        });
        const transport = new StdioClientTransport({
          command: target.command,
          args: target.args,
          cwd: target.cwd,
          env,
          stderr: 'pipe',
        });
        transport.stderr?.on('data', () => {
          // Drain stderr so a chatty server cannot fill the pipe and stall.
        });
        await client.connect(transport, timeout);
        this.connections.set(target.id, {
          client,
          tools: [],
          target,
          accessToken: target.accessToken,
          tokenSlot,
          close: async () => {
            await client.close();
          },
        });
      } else {
        const authProvider = this.authProvider(tokenSlot, target);
        const url = new URL(target.url);
        const options = {
          authProvider,
          fetch: target.fetchImpl,
          requestInit: target.headers && Object.keys(target.headers).length > 0 ? { headers: target.headers } : undefined,
          ...(target.transport === 'http' ? { onInsufficientScope: 'throw' as const } : {}),
        };
        if (target.transport === 'sse') {
          await client.connect(new SSEClientTransport(url, options), timeout);
        } else {
          try {
            await client.connect(new StreamableHTTPClientTransport(url, options), timeout);
          } catch (httpError) {
            if (target.allowUnauthorized && isUnauthorized(httpError)) throw httpError;
            await client.close().catch(() => undefined);
            const fallback = new Client(this.clientInfo);
            try {
              await fallback.connect(new SSEClientTransport(url, options), timeout);
              this.connections.set(target.id, {
                client: fallback,
                tools: [],
                target,
                accessToken: target.accessToken,
                tokenSlot,
                close: async () => {
                  await fallback.close();
                },
              });
              return await this.refreshTools(target.id, target.name);
            } catch (sseError) {
              await fallback.close().catch(() => undefined);
              if (isUnauthorized(sseError) || isUnauthorized(httpError)) throw httpError;
              throw httpError;
            }
          }
        }
        this.connections.set(target.id, {
          client,
          tools: [],
          target,
          accessToken: target.accessToken,
          tokenSlot,
          close: async () => {
            await client.close();
          },
        });
      }
      return await this.refreshTools(target.id, target.name);
    } catch (error) {
      if (target.allowUnauthorized && isUnauthorized(error)) {
        this.errors.delete(target.id);
        return [];
      }
      const scopeError = insufficientScope(error);
      if (scopeError !== undefined || isInsufficient(error)) {
        this.environment.onInsufficientScope?.(target.id, scopeError);
        const message = scopeError
          ? `The MCP server needs a broader scope (${scopeError}). Sign in again.`
          : 'The MCP server needs a broader scope. Sign in again.';
        this.errors.set(target.id, message);
        throw new Error(message, { cause: error });
      }
      const message = error instanceof Error ? error.message : String(error);
      this.errors.set(target.id, message);
      throw new Error(message, { cause: error });
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const live = this.connections.get(serverId);
    this.connections.delete(serverId);
    if (live) await live.close().catch(() => undefined);
  }

  async disconnectAll(): Promise<void> {
    for (const id of [...this.connections.keys()]) await this.disconnect(id);
  }

  async call(serverId: string, toolName: string, args: unknown, accessToken?: string): Promise<string> {
    let live = this.connections.get(serverId);
    if (!live) throw new Error('That MCP server is not connected.');
    if (accessToken && accessToken !== live.accessToken) {
      live.tokenSlot.current = accessToken;
      if (live.target.transport === 'stdio') {
        await this.connect({ ...live.target, accessToken });
        live = this.connections.get(serverId);
        if (!live) throw new Error('That MCP server is not connected.');
      } else {
        live.accessToken = accessToken;
      }
    }
    try {
      const result = await live.client.callTool(
        {
          name: toolName,
          arguments: (args ?? {}) as Record<string, unknown>,
          ...(accessToken ? { _meta: { authorization: `Bearer ${accessToken}` } } : {}),
        },
        live.target.timeoutMs ? { timeout: live.target.timeoutMs } : undefined,
      );
      const parts = (result.content ?? []).map((block) => {
        if (block.type === 'text') return block.text;
        return `[${block.type}]`;
      });
      if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
      const text = parts.join('\n').slice(0, 20_000);
      if (result.isError) throw new Error(text || 'The tool reported an error.');
      return text;
    } catch (error) {
      const scope = insufficientScope(error);
      if (scope !== undefined || isInsufficient(error)) {
        this.environment.onInsufficientScope?.(serverId, scope);
        throw new Error(
          scope
            ? `The MCP server needs a broader scope (${scope}). Sign in again.`
            : 'The MCP server needs a broader scope. Sign in again.',
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async refreshTools(serverId: string, serverName: string): Promise<RuntimeTool[]> {
    const live = this.connections.get(serverId);
    if (!live) return [];
    const listed = await live.client.listTools();
    const tools: RuntimeTool[] = listed.tools.map((tool) => ({
      key: toolKey(serverId, tool.name),
      serverId,
      serverName,
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      readOnlyHint: Boolean(tool.annotations?.readOnlyHint),
    }));
    live.tools = tools;
    return tools;
  }

  private authProvider(tokenSlot: { current?: string }, target: McpConnectTarget): AuthProvider | undefined {
    if (!target.accessToken && !target.refreshAccessToken) return undefined;
    return {
      token: async () => tokenSlot.current,
      onUnauthorized: target.refreshAccessToken
        ? async () => {
            const next = await target.refreshAccessToken?.();
            if (!next) throw new Error('The MCP server requires sign-in.');
            tokenSlot.current = next;
          }
        : undefined,
    };
  }
}

function isUnauthorized(error: unknown): boolean {
  if (UnauthorizedError.isInstance(error)) return true;
  if (error instanceof Error && error.cause && error.cause !== error) return isUnauthorized(error.cause);
  return false;
}

function isInsufficient(error: unknown): boolean {
  if (InsufficientScopeError.isInstance(error)) return true;
  if (error instanceof Error && error.cause && error.cause !== error) return isInsufficient(error.cause);
  return false;
}

function insufficientScope(error: unknown): string | undefined {
  if (InsufficientScopeError.isInstance(error)) return error.requiredScope;
  if (error instanceof Error && error.cause && error.cause !== error) return insufficientScope(error.cause);
  return undefined;
}
