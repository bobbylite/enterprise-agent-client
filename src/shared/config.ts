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
  mcpServers: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      transport: z.enum(['stdio', 'http', 'sse']),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      audience: z.string().optional(),
      scope: z.string().optional(),
    }),
  ),
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
  }),
});

export type EnterpriseConfig = z.infer<typeof enterpriseConfigSchema>;
export type RiskPolicyConfig = EnterpriseConfig['protect']['policy'];

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

export function parseEnterpriseConfig(raw: unknown): EnterpriseConfig {
  assertConfigHasNoSecrets(raw);
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
