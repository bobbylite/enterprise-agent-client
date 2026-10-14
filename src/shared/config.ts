import { z } from 'zod';
import type { InstructionFields, ProviderId, RiskAction, RiskReasonCode } from './types';

const instructionSchema = z.object({
  persona: z.string(),
  communicationStyle: z.string(),
  autonomy: z.string(),
  safety: z.string(),
  untrustedContent: z.string(),
});

const riskAction = z.enum(['allow', 'step_up_mfa', 'restrict_tools', 'read_only', 'block']);
const reasonCode = z.enum([
  'NEW_DEVICE',
  'ANOMALOUS_LOCATION',
  'IMPOSSIBLE_TRAVEL',
  'BOT',
  'ANONYMOUS_NETWORK',
  'IP_REPUTATION',
  'OTHER',
]);

const mcpServerSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(['stdio', 'streamable_http', 'sse', 'builtin']).optional(),
    transport: z.enum(['stdio', 'http', 'sse']).optional(),
    description: z.string().optional(),
    command: z.string().optional(),
    cmd: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    uri: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    envKeys: z.array(z.string()).optional(),
    env_keys: z.array(z.string()).optional(),
    timeout: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
    audience: z.string().optional(),
    scope: z.string().optional(),
  })
  .transform((value) => {
    const type =
      value.type ?? (value.transport === 'http' ? 'streamable_http' : value.transport) ?? 'stdio';
    const transport: 'stdio' | 'http' | 'sse' | 'builtin' = type === 'streamable_http' ? 'http' : type;
    return {
      id: value.id,
      name: value.name,
      type,
      transport,
      description: value.description ?? '',
      command: value.cmd ?? value.command ?? '',
      args: value.args ?? [],
      url: value.uri ?? value.url ?? '',
      headers: value.headers ?? {},
      envKeys: value.envKeys ?? value.env_keys ?? [],
      timeout: value.timeout ?? 300,
      enabled: value.enabled ?? true,
      audience: value.audience ?? '',
      scope: value.scope ?? '',
    };
  });

export const enterpriseConfigSchema = z.object({
  tenant: z.object({
    mode: z.enum(['mock', 'pingone']),
    region: z.string(),
    authHost: z.string(),
    apiHost: z.string(),
    environmentId: z.string(),
    clientId: z.string(),
    redirectUri: z.string(),
    scopes: z.array(z.string()).min(1),
    login: z.object({
      preferred: z.enum(['pi.flow', 'system-browser']),
      allowSystemBrowserFallback: z.boolean(),
      stepUpAcrValues: z.string(),
    }),
  }),
  tokenExchange: z.object({
    clientId: z.string(),
    inspectTokens: z.boolean().optional(),
    audiences: z.array(
      z.object({
        id: z.string().min(1),
        audience: z.string().min(1),
        scope: z.string(),
        serverId: z.string().optional(),
      }),
    ),
  }),
  protect: z.object({
    enabled: z.boolean(),
    riskPolicySetId: z.string(),
    resolvePublicIp: z.boolean(),
    reportedIp: z.string(),
    userType: z.enum(['PING_ONE', 'EXTERNAL']),
    policy: z.object({
      levels: z.object({
        LOW: riskAction,
        MEDIUM: riskAction,
        HIGH: riskAction,
        UNKNOWN: riskAction.default('restrict_tools'),
      }),
      reasonOverrides: z.array(
        z.object({
          code: reasonCode,
          action: riskAction,
        }),
      ),
    }),
  }),
  enterpriseInstructions: instructionSchema,
  access: z
    .object({
      adminGroup: z.string().min(1).default('Administrator'),
      groupsClaim: z.string().min(1).default('groups'),
    })
    .default({ adminGroup: 'Administrator', groupsClaim: 'groups' }),
  authorize: z
    .object({
      decisionEndpointId: z.string().default(''),
      cacheMs: z.number().int().positive().default(30_000),
      mcpServerId: z.string().min(1).default('pingone'),
    })
    .default({ decisionEndpointId: '', cacheMs: 30_000, mcpServerId: 'pingone' }),
  agents: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      nameFromBranding: z.boolean().optional(),
      provider: z.enum(['mock', 'openai', 'anthropic', 'generic']),
      model: z.string().min(1),
      instructions: instructionSchema.optional(),
    }),
  ),
  rooms: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      instructions: z.string(),
      agentIds: z.array(z.string()),
    }),
  ),
  mcpServers: z.array(mcpServerSchema),
  routines: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      prompt: z.string(),
      targetType: z.enum(['agent', 'room']),
      targetId: z.string().min(1),
      cron: z.string().min(1),
      enabled: z.boolean(),
    }),
  ),
  provider: z.object({
    default: z.enum(['mock', 'openai', 'anthropic', 'generic']),
    openaiBaseUrl: z.string(),
    openaiModel: z.string(),
    anthropicBaseUrl: z.string(),
    anthropicModel: z.string(),
    genericBaseUrl: z.string(),
    genericModel: z.string(),
    temperature: z.number().min(0).max(2).optional(),
    reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
    showReasoning: z.boolean().default(true),
  }),
});

export type EnterpriseConfig = z.infer<typeof enterpriseConfigSchema>;
export type RiskPolicyConfig = EnterpriseConfig['protect']['policy'];

export function tokenInspectorEnabled(config: EnterpriseConfig, dev: boolean): boolean {
  if (typeof config.tokenExchange.inspectTokens === 'boolean') return config.tokenExchange.inspectTokens;
  return config.tenant.mode === 'mock' || dev;
}

const SECRET_KEY = /secret|password|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key/i;

export function assertConfigHasNoSecrets(value: unknown, path = 'config'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertConfigHasNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) {
      throw new Error(
        `Refusing to load ${path}.${key}. Store secrets in the environment or the OS keychain.`,
      );
    }
    assertConfigHasNoSecrets(child, `${path}.${key}`);
  }
}

export function assertMcpServersHaveNoEnvValues(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const servers = (raw as { mcpServers?: unknown }).mcpServers;
  if (!Array.isArray(servers)) return;
  servers.forEach((server, index) => {
    if (!server || typeof server !== 'object' || Array.isArray(server)) return;
    const envs = (server as { envs?: unknown }).envs;
    if (envs && typeof envs === 'object' && !Array.isArray(envs) && Object.keys(envs as object).length > 0) {
      throw new Error(
        `Refusing to load config.mcpServers[${index}].envs. Store environment values in the OS keychain and list names in envKeys.`,
      );
    }
  });
}

export function parseEnterpriseConfig(raw: unknown): EnterpriseConfig {
  assertConfigHasNoSecrets(raw);
  assertMcpServersHaveNoEnvValues(raw);
  const parsed = enterpriseConfigSchema.parse(raw);
  if (parsed.tenant.mode === 'pingone') {
    if (!parsed.tenant.environmentId || !parsed.tenant.clientId) {
      throw new Error('PingOne mode requires tenant.environmentId and tenant.clientId.');
    }
    if (!parsed.tenant.authHost || !parsed.tenant.apiHost) {
      throw new Error('PingOne mode requires tenant.authHost and tenant.apiHost.');
    }
    try {
      const redirect = new URL(parsed.tenant.redirectUri);
      if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1') {
        throw new Error('redirect must be an http://127.0.0.1 loopback URL');
      }
    } catch (error) {
      throw new Error(
        `tenant.redirectUri must be an http://127.0.0.1 loopback URL. ${error instanceof Error ? error.message : ''}`.trim(),
        { cause: error },
      );
    }
  }
  for (const agent of parsed.agents) {
    if (!agent.nameFromBranding && !agent.name) {
      throw new Error(`Agent ${agent.id} needs a name or nameFromBranding.`);
    }
  }
  return parsed;
}

export function tokenEndpoint(config: EnterpriseConfig): string {
  return `${trimSlash(config.tenant.authHost)}/${config.tenant.environmentId}/as/token`;
}

export function riskEvaluationsUrl(config: EnterpriseConfig, id?: string): string {
  const base = `${trimSlash(config.tenant.apiHost)}/v1/environments/${config.tenant.environmentId}/riskEvaluations`;
  return id ? `${base}/${id}` : base;
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, '');
}

export type { InstructionFields, ProviderId, RiskAction, RiskReasonCode };
