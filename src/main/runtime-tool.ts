export interface RuntimeTool {
  key: string;
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean;
  /** OpenAI strict tool calling. Only schemas that satisfy strict mode should set this. */
  strict?: boolean;
}
