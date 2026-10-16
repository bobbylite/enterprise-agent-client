import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { EnterpriseConfig } from '@shared/config';
import { riskEvaluationsUrl, tokenEndpoint, tokenInspectorEnabled } from '@shared/config';
import {
  MFA_STATUSES,
  PiFlowClient,
  acceptsCredentialSubmit,
  buildAuthorizeUrl,
  signInStepMessage,
  type FlowSnapshot,
} from '@shared/auth/pi-flow';
import { createPkce, type PkcePair } from '@shared/auth/pkce';
import { beginLoopback, waitForLoopbackCode } from '@shared/auth/loopback';
import { classifyAccessToken, type TokenSet } from '@shared/auth/tokens';
import { groupsFromClaims, isAdmin } from '@shared/access/groups';
import {
  applyLiveRiskGates,
  decisionCacheKey,
  evaluatePolicies,
  failClosed,
  featuresFromAuthorize,
  mergeScaffold,
  parseScaffoldMarker,
  policiesForEvaluation,
  reconcilePolicyCache,
  scaffoldPolicies,
  sessionRestriction as explainRestriction,
  SCAFFOLD_MARKER,
  type AuthorizePolicy,
  type DecisionInput,
} from '@shared/authorize/policy';
import { decisionTokensReady, introspectionNote as describeIntrospection, type DecisionCall } from '@shared/authorize/framework';
import { plannedFeaturePolicy, provisionAuthorize } from '@shared/authorize/provision';
import { AuthorizeClient, listRemotePolicies, postDecision, setRemotePolicyEnabled, syncRemoteScaffold } from '@shared/authorize/remote';
import { decodeJwtPayload, encodeJsonSegment, randomId } from '@shared/ids';
import { PINGONE_SKILL_ID, pingoneSkillInstructions, type SkillDraft } from '@shared/skills/markdown';
import { toolKey } from '@shared/mcp/approvals';
import { splitCommandLine } from '@shared/mcp/command';
import {
  mcpEnvAccount,
  mcpOauthTokenAccount,
  refreshStoredMcpToken,
  runMcpAuthorization,
  McpOauthError,
} from '@shared/mcp/oauth';
import {
  isSkillReferenceTool,
  loadSkillBundle,
  pingoneAuthorizeSkillLayer,
  readSkillReferenceFile,
  resolveSkillBundle,
  skillReferenceDenied,
  skillReferenceToolFields,
  SKILL_REFERENCE_SERVER_ID,
  SKILL_REFERENCE_TOOL,
  type SkillBundle,
} from './skill-bundle';
import { RiskEvaluationError, buildRiskEvent, createRiskEvaluation, resolvePublicIp, updateRiskEvaluation } from '@shared/protect/evaluate';
import { mockRiskPayload } from '@shared/protect/mock';
import { classifyProtectPollFailure, nextProtectDelayMs } from '@shared/protect/poll';
import { decideRisk, summarizeRisk, unscoredRisk } from '@shared/protect/policy';
import { extractRiskReasons, riskLevel } from '@shared/protect/reasons';
import { renderRiskContext } from '@shared/protect/context';
import { defaultModelFor } from '@shared/providers/index';
import type { ProviderMessage } from '@shared/providers/types';
import { assertValidCron, cronMatches, minuteKey } from '@shared/schedule/cron';
import type { SecretStore } from '@shared/secrets';
import { isCancellation } from '@shared/providers/types';
import { AudienceTokenCache, fetchClientCredentials, getOrExchange } from '@shared/tokens/exchange';
import { redactSecrets } from '@shared/env';
import { inspectJwt } from '@shared/tokens/inspect';
import type {
  AgentInput,
  AgentPage,
  AgentProfile,
  AppState,
  AuditView,
  FeatureDecision,
  PolicyCacheReset,
  PolicyDryRun,
  PolicyScaffoldResult,
  PolicyView,
  SkillInput,
  SkillView,
  ApprovalChoice,
  ApprovalRequest,
  Attachment,
  Branding,
  ChatEvent,
  ChatSnapshot,
  InstructionEditorState,
  InstructionFields,
  LoginView,
  McpAuthStep,
  McpServerInput,
  McpServerView,
  McpSignInInput,
  MockScenario,
  ProviderId,
  RiskView,
  Room,
  RoomInput,
  Routine,
  RoutineInput,
  RoutineRun,
  SessionView,
  SettingsInput,
  SettingsView,
  InspectedToken,
} from '@shared/types';
import { compileAgentGraph, runAgentGraph, type AgentGraph, type GraphParticipant } from './agent-graph';
import { loadEnterprise } from './load-config';
import type { RuntimeTool } from './runtime-tool';
import { openCheckpointer, type NodeSqliteSaver } from './checkpoint-sqlite';
import { Repository, type AgentRow, type McpServerRow, type SkillRow } from './db';
import { skillFromUpload } from './skill-files';
import { McpHub } from './mcp';

interface StoredSession {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  tokenType: string;
  userId: string;
  username: string;
  groups: string[];
}

interface PendingLogin {
  userId: string;
  username: string;
  signals: string;
  obtainTokens: () => Promise<TokenSet>;
}

export interface PickedFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface RuntimeOptions {
  config: EnterpriseConfig;
  branding: Branding;
  db: Repository;
  secrets: SecretStore;
  appRoot: string;
  attachmentsDir: string;
  encryptionAvailable: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  openExternal?: (url: string) => Promise<void>;
  pickFiles?: () => Promise<PickedFile[]>;
  now?: () => number;
  emit?: (event: ChatEvent) => void;
  onState?: (state: AppState) => void;
  collectSignals?: () => Promise<string>;
  protectActive?: () => boolean;
  schedule?: (delayMs: number, run: () => Promise<void>) => () => void;
  configPath?: string;
  mockDelayMs?: number;
  version?: string;
  dev?: boolean;
  checkpointPath?: string;
  userDataDir?: string;
  logPath?: string;
  log?: (level: 'debug' | 'error', message: string) => void;
}

const SCENARIOS: MockScenario[] = ['low', 'new_device', 'anomalous_location', 'impossible_travel', 'bot'];
const AGENT_TOKEN_ACCOUNT = 'agentAccessToken';

export class Runtime {
  private session: StoredSession | null = null;
  private risk: RiskView | null = null;
  private login: LoginView = { phase: 'idle' };
  private stepUpRequired = false;
  private scenario: MockScenario = 'low';
  private mockAdmin = false;
  private features: FeatureDecision = failClosed(0);
  private decisionCache: { key: string; at: number; decision: FeatureDecision } | null = null;
  private policyEpoch = 0;
  private pkce: PkcePair | null = null;
  private flow: FlowSnapshot | null = null;
  private mfaSatisfied = false;
  private stepUpRestarted = false;
  private pendingLogin: PendingLogin | null = null;
  private pendingSignals = '';
  private browserAbort: AbortController | null = null;
  private workerToken: TokenSet | null = null;
  private agentActorToken: TokenSet | null = null;
  private readonly exchangeErrors = new Map<string, string>();
  private readonly oauthSteps = new Map<string, McpAuthStep[]>();
  private readonly oauthSignedIn = new Set<string>();
  private readonly needsClient = new Set<string>();
  private readonly pendingScopes = new Map<string, string>();
  private readonly approvals = new Map<string, (choice: ApprovalChoice) => void>();
  private readonly pi: PiFlowClient;
  private readonly cache: AudienceTokenCache;
  private readonly hub: McpHub;
  private readonly checkpointer: NodeSqliteSaver;
  private readonly agentGraph: AgentGraph;
  private readonly authorize: AuthorizeClient;
  private readonly pingoneBundle: SkillBundle | null;
  private firing = false;
  private protectCancel: (() => void) | null = null;
  private protectPollTask: Promise<void> | null = null;
  private protectQueued = false;
  private protectGeneration = 0;
  private protectRetryAfterSeconds: number | null = null;
  private activeTurn: AbortController | null = null;
  private activeConversationId = '';
  private cancelledConversations = new Set<string>();

  private constructor(private readonly options: RuntimeOptions) {
    this.pi = new PiFlowClient({
      authHost: options.config.tenant.authHost,
      environmentId: options.config.tenant.environmentId,
      clientId: options.config.tenant.clientId,
      fetchImpl: options.fetchImpl,
      now: options.now,
    });
    this.cache = new AudienceTokenCache(options.secrets, 60_000, options.now);
    this.hub = new McpHub(
      { name: options.branding.appName, version: options.version ?? '0.1.0' },
      {
        platform: process.platform,
        home: options.env?.HOME ?? process.env.HOME,
        onInsufficientScope: (serverId, scope) => {
          if (scope) this.pendingScopes.set(serverId, scope);
          const steps = this.oauthSteps.get(serverId) ?? [];
          this.oauthSteps.set(serverId, [
            ...steps,
            {
              kind: 'step-up',
              title: 'Insufficient scope',
              detail: scope
                ? `The server returned 403 insufficient_scope for ${scope}. Sign in again to request it.`
                : 'The server returned 403 insufficient_scope. Sign in again to request a broader scope.',
              ok: false,
            },
          ]);
        },
      },
    );
    this.checkpointer = openCheckpointer(options.checkpointPath ?? join(options.attachmentsDir, 'langgraph.sqlite'));
    this.agentGraph = compileAgentGraph(this.checkpointer);
    this.authorize = new AuthorizeClient({ fetchImpl: options.fetchImpl, now: options.now });
    const bundleRoot = resolveSkillBundle(options.appRoot);
    this.pingoneBundle = bundleRoot ? loadSkillBundle(bundleRoot) : null;
  }

  static async create(options: RuntimeOptions): Promise<Runtime> {
    const runtime = new Runtime(options);
    await runtime.init();
    return runtime;
  }

  async dispose(): Promise<void> {
    this.stopProtectPoll();
    this.browserAbort?.abort();
    await this.hub.disconnectAll();
    this.checkpointer.close();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  setEmitter(emit: (event: ChatEvent) => void): void {
    this.options.emit = emit;
  }

  setStatePublisher(onState: (state: AppState) => void): void {
    this.options.onState = onState;
  }

  setSignalCollector(collectSignals: () => Promise<string>): void {
    this.options.collectSignals = collectSignals;
  }

  setProtectActive(protectActive: () => boolean): void {
    this.options.protectActive = protectActive;
  }

  private emit(event: ChatEvent): void {
    this.options.emit?.(event);
  }

  private env(name: string): string {
    return this.options.env?.[name]?.trim() ?? '';
  }

  async init(): Promise<void> {
    await this.hydrateSecrets();
    this.seed();
    this.migrateAgentOwnership();
    this.syncBrandedAgents();
    this.ensureBuiltinSkill();
    this.mockAdmin = this.options.db.getSetting('mockAdmin') === '1';
    const storedScenario = this.options.db.getSetting('mockScenario');
    if (storedScenario && SCENARIOS.includes(storedScenario as MockScenario)) {
      this.scenario = storedScenario as MockScenario;
    }
    await this.restoreSession();
  }

  state(): AppState {
    return {
      mode: this.options.config.tenant.mode,
      session: this.sessionView(),
      risk: this.risk,
      stepUpRequired: this.stepUpRequired,
      encryptionAvailable: this.options.encryptionAvailable,
      loginPreferred: this.options.config.tenant.login.preferred,
      allowSystemBrowserFallback: this.options.config.tenant.login.allowSystemBrowserFallback,
      mockScenario: this.scenario,
      login: this.login,
      showReasoning: this.options.config.provider.showReasoning,
      adminGroup: this.options.config.access.adminGroup,
      mockAdmin: this.mockAdmin,
      features: this.currentFeatures(),
      restriction: this.sessionRestriction(),
    };
  }

  async submitCredentials(username: string, password: string, signals: string): Promise<AppState> {
    const name = username.trim();
    if (!name || !password) throw new Error('Enter a username and password.');
    this.pendingSignals = signals;
    if (this.options.config.tenant.mode === 'mock') {
      return this.completeLogin({
        userId: `mock:${name}`,
        username: name,
        signals,
        mfaSatisfied: false,
        obtainTokens: async () => this.mockToken(`mock:${name}`),
      });
    }
    if (!this.flow || !acceptsCredentialSubmit(this.flow)) {
      this.pkce = await createPkce();
      this.mfaSatisfied = false;
      this.flow = await this.pi.startAuthorize({
        redirectUri: this.options.config.tenant.redirectUri,
        scopes: this.options.config.tenant.scopes,
        challenge: this.pkce.challenge,
        state: this.pkce.state,
      });
    }
    if (!acceptsCredentialSubmit(this.flow)) return this.advance(this.flow, signals);
    const next = await this.pi.submitCredentials(this.flow, name, password);
    return this.advance(next, signals);
  }

  async submitOtp(otp: string, signals: string): Promise<AppState> {
    if (this.pendingLogin) {
      if (!/^\d{6}$/.test(otp.trim())) throw new Error('Enter a 6-digit verification code.');
      const pending = this.pendingLogin;
      this.pendingLogin = null;
      const tokens = await pending.obtainTokens();
      await this.activate(tokens, pending.userId, pending.username);
      await this.markRisk('SUCCESS');
      return this.state();
    }
    if (!this.flow) throw new Error('Start sign-in again.');
    const next = await this.pi.submitOtp(this.flow, otp.trim());
    this.mfaSatisfied = true;
    return this.advance(next, signals || this.pendingSignals);
  }

  async selectDevice(deviceId: string, signals: string): Promise<AppState> {
    if (!this.flow) throw new Error('Start sign-in again.');
    const next = await this.pi.selectDevice(this.flow, deviceId);
    return this.advance(next, signals || this.pendingSignals);
  }

  async startSystemBrowserLogin(signals: string): Promise<AppState> {
    this.pendingSignals = signals;
    if (this.options.config.tenant.mode === 'mock') {
      return this.completeLogin({
        userId: 'mock:browser-user',
        username: 'browser-user',
        signals,
        mfaSatisfied: false,
        obtainTokens: async () => this.mockToken('mock:browser-user'),
      });
    }
    this.pkce = await createPkce();
    const url = buildAuthorizeUrl({
      authHost: this.options.config.tenant.authHost,
      environmentId: this.options.config.tenant.environmentId,
      clientId: this.options.config.tenant.clientId,
      redirectUri: this.options.config.tenant.redirectUri,
      scopes: this.options.config.tenant.scopes,
      challenge: this.pkce.challenge,
      state: this.pkce.state,
      responseMode: 'query',
    });
    this.browserAbort = new AbortController();
    const pending = waitForLoopbackCode({
      redirectUri: this.options.config.tenant.redirectUri,
      expectedState: this.pkce.state,
      signal: this.browserAbort.signal,
    });
    this.login = { phase: 'browser-wait', message: 'Continue in the browser window.' };
    if (!this.options.openExternal) throw new Error('System browser sign-in is not available.');
    await this.options.openExternal(url);
    const { code } = await pending;
    const verifier = this.pkce.verifier;
    const tokens = await this.pi.exchangeCode({
      code,
      verifier,
      redirectUri: this.options.config.tenant.redirectUri,
    });
    const payload = decodeJwtPayload(tokens.idToken || tokens.accessToken);
    const userId = typeof payload.sub === 'string' ? payload.sub : 'user';
    const username = stringClaim(payload.preferred_username) || stringClaim(payload.email) || userId;
    return this.completeLogin({
      userId,
      username,
      signals,
      mfaSatisfied: false,
      obtainTokens: async () => tokens,
    });
  }

  async cancelLogin(): Promise<AppState> {
    this.browserAbort?.abort();
    this.browserAbort = null;
    this.flow = null;
    this.pkce = null;
    this.pendingLogin = null;
    this.stepUpRequired = false;
    this.mfaSatisfied = false;
    this.stepUpRestarted = false;
    this.login = { phase: 'idle' };
    return this.state();
  }

  async setMockScenario(scenario: MockScenario): Promise<AppState> {
    if (this.options.config.tenant.mode !== 'mock') {
      throw new Error('Risk scenarios are only available in mock mode.');
    }
    this.scenario = scenario;
    this.options.db.setSetting('mockScenario', scenario);
    if (this.session) await this.runProtectPoll(true);
    return this.state();
  }

  async setMockAdmin(admin: boolean): Promise<AppState> {
    if (this.options.config.tenant.mode !== 'mock') {
      throw new Error('The administrator sign-in switch is only available in mock mode.');
    }
    this.mockAdmin = admin;
    this.options.db.setSetting('mockAdmin', admin ? '1' : '0');
    return this.state();
  }

  async logout(): Promise<AppState> {
    this.stopProtectPoll();
    this.session = null;
    this.risk = null;
    this.features = failClosed(this.now());
    this.decisionCache = null;
    this.stepUpRequired = false;
    this.pendingLogin = null;
    this.flow = null;
    await this.options.secrets.delete('session');
    this.options.db.setSetting('risk', '');
    await this.hub.disconnectAll();
    this.login = { phase: 'idle' };
    return this.state();
  }

  listConversations() {
    this.requireSession();
    return this.options.db.listConversations().filter((item) => item.kind === 'direct');
  }

  createConversation(): ChatSnapshot {
    this.requireSession();
    const agent = this.defaultAgent();
    const now = this.now();
    const conversation = {
      id: randomId(),
      title: 'New chat',
      kind: 'direct' as const,
      agentId: agent.id,
      roomId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.options.db.insertConversation(conversation);
    return { conversation, messages: [] };
  }

  openConversation(id: string): ChatSnapshot {
    this.requireSession();
    const conversation = this.options.db.getConversation(id);
    if (!conversation) throw new Error('That conversation was not found.');
    return { conversation, messages: this.options.db.listMessages(id) };
  }

  async sendMessage(conversationId: string, text: string, attachmentIds: string[]): Promise<void> {
    const conversation = this.openConversation(conversationId).conversation;
    this.requireWritableChat();
    const body = text.trim();
    if (!body && attachmentIds.length === 0) throw new Error('Write a message or attach a file.');
    const messageId = randomId();
    const now = this.now();
    this.options.db.insertMessage({
      id: messageId,
      conversationId,
      role: 'user',
      authorId: this.session?.userId ?? null,
      authorName: this.session?.username ?? 'You',
      content: body,
      createdAt: now,
    });
    if (attachmentIds.length > 0) this.options.db.linkAttachments(messageId, attachmentIds);
    if (conversation.title === 'New chat' && body) {
      this.options.db.touchConversation(conversationId, now, body.slice(0, 48));
    } else {
      this.options.db.touchConversation(conversationId, now);
    }
    const agent = this.options.db.getAgent(conversation.agentId ?? '') ?? this.defaultAgent();
    this.cancelledConversations.delete(conversationId);
    try {
      await this.runGraph(conversationId, [{ agent }]);
    } catch (error) {
      if (isCancellation(error)) return;
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      this.emit({ type: 'error', conversationId, message });
      throw new Error(message, { cause: error });
    }
  }

  async pickAttachments(): Promise<Attachment[]> {
    this.requireSession();
    if (!this.options.pickFiles) throw new Error('File picking is not available.');
    const files = await this.options.pickFiles();
    mkdirSync(this.options.attachmentsDir, { recursive: true });
    return files.map((file) => {
      const id = randomId();
      const name = basename(file.name) || 'attachment';
      const path = join(this.options.attachmentsDir, `${id}-${name}`);
      writeFileSync(path, file.bytes);
      this.options.db.insertAttachment({
        id,
        messageId: null,
        name,
        mime: file.mime || 'application/octet-stream',
        size: file.bytes.byteLength,
        path,
      });
      const previewDataUrl =
        file.mime.startsWith('image/') && file.bytes.byteLength < 200_000
          ? `data:${file.mime};base64,${Buffer.from(file.bytes).toString('base64')}`
          : undefined;
      return { id, messageId: null, name, mime: file.mime, size: file.bytes.byteLength, previewDataUrl };
    });
  }

  listAgents(): AgentProfile[] {
    return this.options.db.listAgents().map((agent) => this.profile(agent));
  }

  openAgent(id: string): AgentPage {
    const agent = this.options.db.getAgent(id);
    if (!agent) throw new Error('That agent was not found.');
    return this.agentPage(agent);
  }

  saveAgent(input: AgentInput): AgentPage {
    this.requireAgentConfig();
    const existing = input.id ? this.options.db.getAgent(input.id) : null;
    if (input.id && !existing) throw new Error('That agent was not found.');
    const provider = input.provider;
    if (!['mock', 'openai', 'anthropic', 'generic'].includes(provider)) throw new Error('Choose a provider.');
    if (!input.model.trim()) throw new Error('Choose a model.');
    const name = existing?.nameFromBranding ? this.options.branding.agentName : input.name.trim();
    if (!name) throw new Error('Give the agent a name.');
    const agent: AgentRow = {
      id: existing?.id ?? randomId(),
      name,
      provider,
      model: input.model.trim(),
      nameFromBranding: existing?.nameFromBranding ?? false,
      instructions: input.persona,
      userInstructions: input.user,
      skillIds: existing?.skillIds ?? [],
    };
    this.options.db.upsertAgent(agent);
    if (agent.nameFromBranding) this.options.db.setSetting('personaCustomized', '1');
    return this.agentPage(agent);
  }

  listSkills(): SkillView[] {
    this.requireSession();
    return this.options.db.listSkills().filter((skill) => this.skillVisible(skill)).map((skill) => this.skillView(skill, []));
  }

  importSkill(input: SkillInput): SkillView {
    this.requireAgentConfig();
    const name = input.name.trim();
    if (!name) throw new Error('Give the skill a name.');
    if (!input.instructions.trim()) throw new Error('Write the skill instructions.');
    const skill: SkillRow = {
      id: randomId(),
      name,
      description: input.description.trim(),
      instructions: input.instructions.trim(),
      files: [],
      requiredGroups: input.requiredGroups.map((group) => group.trim()).filter(Boolean),
      requiresAdmin: false,
      builtin: false,
      enabled: true,
      createdAt: this.now(),
    };
    this.options.db.upsertSkill(skill);
    return this.skillView(skill, []);
  }

  async importSkillFile(): Promise<SkillView> {
    this.requireAgentConfig();
    if (!this.options.pickFiles) throw new Error('File picking is not available.');
    const files = await this.options.pickFiles();
    const file = files[0];
    if (!file) throw new Error('Choose a SKILL.md file or a zip that contains one.');
    return this.storeSkillDraft(skillFromUpload(file.name, file.bytes));
  }

  setSkillEnabled(id: string, enabled: boolean): SkillView[] {
    this.requireAgentConfig();
    const skill = this.options.db.getSkill(id);
    if (!skill || !this.skillVisible(skill)) throw new Error('That skill was not found.');
    if (skill.requiresAdmin) this.requireAdmin();
    this.options.db.upsertSkill({ ...skill, enabled });
    return this.listSkills();
  }

  deleteSkill(id: string): SkillView[] {
    this.requireAgentConfig();
    const skill = this.options.db.getSkill(id);
    if (!skill || !this.skillVisible(skill)) throw new Error('That skill was not found.');
    if (skill.builtin) throw new Error('The built-in PingOne skill stays.');
    this.options.db.deleteSkill(id);
    for (const agent of this.options.db.listAgents()) {
      if (!agent.skillIds.includes(id)) continue;
      this.options.db.upsertAgent({ ...agent, skillIds: agent.skillIds.filter((skillId) => skillId !== id) });
    }
    return this.listSkills();
  }

  assignSkill(agentId: string, skillId: string, assigned: boolean): AgentPage {
    this.requireAgentConfig();
    const agent = this.options.db.getAgent(agentId);
    if (!agent) throw new Error('That agent was not found.');
    const skill = this.options.db.getSkill(skillId);
    if (!skill || !this.skillVisible(skill)) throw new Error('That skill was not found.');
    if (skill.requiresAdmin) this.requireAdmin();
    if (assigned && !this.skillUsable(skill)) {
      throw new Error(`This sign-in does not meet the groups required by ${skill.name}.`);
    }
    const skillIds = assigned
      ? [...new Set([...agent.skillIds, skillId])]
      : agent.skillIds.filter((id) => id !== skillId);
    const saved = { ...agent, skillIds };
    this.options.db.upsertAgent(saved);
    return this.agentPage(saved);
  }

  async listPolicies(): Promise<PolicyView[]> {
    this.requirePolicy();
    return this.options.db.listPolicies().map(policyView);
  }

  async refreshPolicies(): Promise<PolicyView[]> {
    this.requirePolicy();
    if (this.options.config.tenant.mode === 'pingone') {
      await this.authorize.run(() => this.pullRemotePolicies());
    }
    this.decisionCache = null;
    await this.refreshFeatures();
    return this.listPolicies();
  }

  async resetPolicyCache(): Promise<PolicyCacheReset> {
    this.requirePolicy();
    this.policyEpoch += 1;
    this.decisionCache = null;
    const removed = this.options.db.listPolicies();
    for (const policy of removed) this.options.db.deletePolicy(policy.id);
    this.options.db.clearTfObjects();
    const cleared = policyResetDetail(removed.map((policy) => policy.name));
    this.audit(null, 'policy:reset-cache', cleared);
    await this.refreshFeatures();
    return { policies: [], cleared };
  }

  async scaffoldPolicies(confirm: boolean): Promise<PolicyScaffoldResult> {
    this.requirePolicy();
    const incoming = scaffoldPolicies(this.options.config.access.adminGroup, this.now(), this.session?.username ?? '');
    const note = this.introspectionNote();
    if (!confirm) {
      const existing = this.options.db.listPolicies();
      return { preview: incoming.map(policyView), created: [], policies: existing.map(policyView), introspectionNote: note };
    }
    const result = await this.authorize.run(() => this.confirmScaffold(incoming));
    return { ...result, introspectionNote: note };
  }

  async dryRunAuthorizePolicy(): Promise<PolicyDryRun> {
    this.requirePolicy();
    const directory = this.options.userDataDir ?? this.options.attachmentsDir;
    const path = join(directory, 'authorize-policy-tree.json');
    if (this.options.config.tenant.mode !== 'pingone') {
      const body = plannedFeaturePolicy(new Map(), this.options.config.access.adminGroup, this.options.config.authorize.delegations);
      mkdirSync(directory, { recursive: true });
      const text = `${JSON.stringify(body, null, 2)}\n`;
      writeFileSync(path, text);
      const note = this.introspectionNote();
      this.options.log?.('debug', `Authorize dry run wrote ${path}\n${text}\n${note}`);
      return { path, introspectionNote: note };
    }
    const token = await this.workerAccessToken();
    const result = await provisionAuthorize({
      config: this.options.config,
      accessToken: token,
      client: this.authorize,
      store: {
        get: (kind, name) => this.options.db.getTfObject(kind, name),
        put: (kind, name, remoteId, contentHash) => this.options.db.upsertTfObject(kind, name, remoteId, contentHash),
      },
      adminGroup: this.options.config.access.adminGroup,
      delegations: this.options.config.authorize.delegations,
      alwaysCurrent: this.options.config.authorize.alwaysCurrent,
      shouldContinue: () => true,
      dryRun: true,
      dryRunPath: path,
      log: this.options.log,
      logPath: this.options.logPath,
    });
    if (!result.dryRunPath) throw new Error('Dry run did not write the policy tree.');
    return { path: result.dryRunPath, introspectionNote: this.introspectionNote() };
  }

  async setPolicyEnabled(id: string, enabled: boolean): Promise<PolicyView[]> {
    this.requirePolicy();
    const policy = this.options.db.listPolicies().find((item) => item.id === id);
    if (!policy) throw new Error('That policy was not found.');
    const next = { ...policy, enabled, updatedAt: this.now(), updatedBy: this.session?.username ?? null };
    if (this.options.config.tenant.mode === 'pingone' && next.remoteId) {
      const token = await this.workerAccessToken();
      await setRemotePolicyEnabled(this.options.config, token, next.remoteId, enabled, this.authorize);
    }
    this.options.db.upsertPolicy(next);
    this.audit(null, 'policy:enforcement', `${next.name} ${enabled ? 'enabled' : 'disabled'}`);
    this.decisionCache = null;
    await this.refreshFeatures();
    return this.options.db.listPolicies().map(policyView);
  }

  listAudit(): AuditView[] {
    this.requireAdmin();
    return this.options.db.listAudit();
  }

  deleteAgent(id: string): void {
    this.requireAgentConfig();
    const agent = this.options.db.getAgent(id);
    if (!agent) throw new Error('That agent was not found.');
    if (agent.nameFromBranding) throw new Error('The branding agent stays. Edit it instead of deleting it.');
    if (this.options.db.listAgents().length <= 1) throw new Error('Keep at least one agent.');
    this.options.db.deleteAgent(id);
  }

  listRooms(): Room[] {
    this.requireSession();
    return this.options.db.listRooms();
  }

  saveRoom(input: RoomInput): Room {
    this.requireAgentConfig();
    if (!input.name.trim()) throw new Error('Give the room a name.');
    if (input.agentIds.length === 0) throw new Error('Choose at least one agent.');
    const existing = input.id ? this.options.db.getRoom(input.id) : null;
    const room = {
      id: input.id || randomId(),
      name: input.name.trim(),
      instructions: input.instructions,
      createdAt: existing?.createdAt ?? this.now(),
      agentIds: input.agentIds,
    };
    this.options.db.upsertRoom(room);
    return room;
  }

  deleteRoom(id: string): void {
    this.requireAgentConfig();
    this.options.db.deleteRoom(id);
  }

  openRoom(id: string): ChatSnapshot {
    this.requireSession();
    const room = this.options.db.getRoom(id);
    if (!room) throw new Error('That room was not found.');
    let conversation = this.options.db.findRoomConversation(id);
    if (!conversation) {
      const now = this.now();
      conversation = {
        id: randomId(),
        title: room.name,
        kind: 'room',
        agentId: null,
        roomId: id,
        createdAt: now,
        updatedAt: now,
      };
      this.options.db.insertConversation(conversation);
    }
    return { conversation, messages: this.options.db.listMessages(conversation.id) };
  }

  async sendRoomMessage(roomId: string, text: string): Promise<void> {
    const snapshot = this.openRoom(roomId);
    this.requireWritableChat();
    const body = text.trim();
    if (!body) throw new Error('Write a message.');
    const room = this.options.db.getRoom(roomId);
    if (!room) throw new Error('That room was not found.');
    const now = this.now();
    this.options.db.insertMessage({
      id: randomId(),
      conversationId: snapshot.conversation.id,
      role: 'user',
      authorId: this.session?.userId ?? null,
      authorName: this.session?.username ?? 'You',
      content: body,
      createdAt: now,
    });
    this.options.db.touchConversation(snapshot.conversation.id, now);
    this.cancelledConversations.delete(snapshot.conversation.id);
    const participants = room.agentIds.flatMap((agentId) => {
      const agent = this.options.db.getAgent(agentId);
      return agent ? [{ agent, room: room.instructions }] : [];
    });
    await this.runGraph(snapshot.conversation.id, participants);
  }

  stopGeneration(conversationId: string): void {
    this.cancelledConversations.add(conversationId);
    if (this.activeConversationId === conversationId) this.activeTurn?.abort();
  }

  deleteConversation(id: string): void {
    this.requireSession();
    this.stopGeneration(id);
    for (const path of this.options.db.deleteConversation(id)) this.removeFile(path);
  }

  deleteRoomHistory(roomId: string): void {
    this.requireSession();
    const conversation = this.options.db.findRoomConversation(roomId);
    if (!conversation) return;
    this.stopGeneration(conversation.id);
    for (const path of this.options.db.clearConversationMessages(conversation.id)) this.removeFile(path);
  }

  private removeFile(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      // The file was already removed.
    }
  }

  getInstructions(): InstructionEditorState {
    return this.instructionState(this.defaultAgent());
  }

  savePersona(fields: InstructionFields): InstructionEditorState {
    this.requireAgentConfig();
    const agent = this.defaultAgent();
    this.options.db.upsertAgent({ ...agent, instructions: fields });
    this.options.db.setSetting('personaCustomized', '1');
    return this.getInstructions();
  }

  saveUserLayer(fields: InstructionFields): InstructionEditorState {
    this.requireAgentConfig();
    const agent = this.defaultAgent();
    this.options.db.upsertAgent({ ...agent, userInstructions: fields });
    return this.getInstructions();
  }

  resetPersona(): InstructionEditorState {
    this.requireAgentConfig();
    const agent = this.defaultAgent();
    this.options.db.upsertAgent({ ...agent, instructions: this.options.branding.persona });
    this.options.db.setSetting('personaCustomized', '0');
    return this.getInstructions();
  }

  async listMcpServers(): Promise<McpServerView[]> {
    const rows = this.options.db.listMcpServers();
    await Promise.all(rows.map((server) => this.rememberOauth(server)));
    return rows.map((server) => this.serverView(server));
  }

  async saveMcpServer(input: McpServerInput): Promise<McpServerView> {
    this.requireExtensionConfig();
    if (!input.name.trim()) throw new Error('Give the extension a name.');
    const existing = input.id ? this.options.db.listMcpServers().find((item) => item.id === input.id) : undefined;
    const kind = extensionKind(input);
    const commandLine = input.args.trim() ? null : splitCommandLine(input.command);
    const row: McpServerRow = {
      id: input.id || randomId(),
      name: input.name.trim(),
      transport: kind,
      description: input.description?.trim() ?? existing?.description ?? '',
      command: commandLine ? commandLine.command : input.command.trim(),
      args: commandLine ? commandLine.args : parseArgs(input.args),
      url: input.url.trim(),
      headers: input.headers ? headerRecord(input.headers) : (existing?.headers ?? {}),
      envKeys: existing?.envKeys ?? [],
      timeout: input.timeout ?? existing?.timeout ?? 300,
      audience: input.audience !== undefined ? input.audience.trim() : (existing?.audience ?? ''),
      scope: input.scope !== undefined ? input.scope.trim() : (existing?.scope ?? ''),
      enabled: input.enabled,
    };
    if (input.env) row.envKeys = await this.storeExtensionEnv(row.id, input.env, existing?.envKeys ?? []);
    if (row.transport === 'stdio' && !row.command) throw new Error('A stdio extension needs a command.');
    if (row.transport !== 'stdio' && row.transport !== 'builtin' && !row.url) throw new Error('An HTTP extension needs a URL.');
    if (!Number.isInteger(row.timeout) || row.timeout < 1) throw new Error('Timeout must be a positive number of seconds.');
    this.options.db.upsertMcpServer(row);
    await this.rememberOauth(row);
    return this.serverView(row);
  }

  async deleteMcpServer(id: string): Promise<void> {
    this.requireExtensionConfig();
    const server = this.options.db.listMcpServers().find((item) => item.id === id);
    await this.hub.disconnect(id);
    if (server) {
      for (const key of server.envKeys) await this.options.secrets.delete(mcpEnvAccount(id, key));
    }
    await this.options.secrets.delete(mcpOauthTokenAccount(id));
    this.oauthSignedIn.delete(id);
    this.oauthSteps.delete(id);
    this.needsClient.delete(id);
    this.pendingScopes.delete(id);
    this.options.db.deleteMcpServer(id);
  }

  async setMcpEnabled(id: string, enabled: boolean): Promise<McpServerView> {
    this.requireExtensionConfig();
    const server = this.options.db.listMcpServers().find((item) => item.id === id);
    if (!server) throw new Error('That extension was not found.');
    const next = { ...server, enabled };
    this.options.db.upsertMcpServer(next);
    if (!enabled) {
      await this.hub.disconnect(id);
      await this.rememberOauth(next);
      return this.serverView(next);
    }
    const token = this.usesOauth(next) ? await this.currentOauthAccessToken(next.id) : undefined;
    if (this.session && !this.stepUpRequired && next.transport !== 'builtin' && !(this.usesOauth(next) && !token)) {
      return this.connectMcp(id);
    }
    await this.rememberOauth(next);
    return this.serverView(next);
  }

  async connectMcp(id: string): Promise<McpServerView> {
    this.requireExtensionConfig();
    const server = this.options.db.listMcpServers().find((item) => item.id === id);
    if (!server) throw new Error('That extension was not found.');
    if (!server.enabled) throw new Error('This extension is disabled.');
    if (server.transport === 'builtin') throw new Error('Built-in extensions are not launched by this client.');
    const accessToken = await this.accessTokenForServer(server);
    await this.hub.connect({
      id: server.id,
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      cwd: this.options.appRoot,
      env: await this.extensionEnv(server),
      headers: server.headers,
      timeoutMs: server.timeout * 1000,
      accessToken,
      fetchImpl: this.options.fetchImpl,
      allowUnauthorized: this.usesOauth(server) && !accessToken,
      refreshAccessToken: this.usesOauth(server) ? async () => this.currentOauthAccessToken(server.id) : undefined,
    });
    await this.rememberOauth(server);
    if (this.usesOauth(server) && !accessToken && this.hub.status(server.id) !== 'connected') {
      throw new Error('This extension needs sign-in.');
    }
    return this.serverView(server);
  }

  async disconnectMcp(id: string): Promise<McpServerView> {
    this.requireExtensionConfig();
    await this.hub.disconnect(id);
    const server = this.options.db.listMcpServers().find((item) => item.id === id);
    if (!server) throw new Error('That extension was not found.');
    await this.rememberOauth(server);
    return this.serverView(server);
  }

  async signInMcp(id: string, manual?: McpSignInInput): Promise<McpServerView> {
    this.requireExtensionConfig();
    const server = this.options.db.listMcpServers().find((item) => item.id === id);
    if (!server) throw new Error('That extension was not found.');
    if (!this.usesOauth(server)) throw new Error('This extension does not use MCP authorization.');
    if (!this.options.openExternal) throw new Error('System browser sign-in is not available.');
    const openExternal = this.options.openExternal;
    try {
      const outcome = await runMcpAuthorization({
        extensionId: server.id,
        serverUrl: server.url,
        secrets: this.options.secrets,
        fetchImpl: this.options.fetchImpl,
        now: () => this.now(),
        manualClient: manual?.clientId ? { clientId: manual.clientId, clientSecret: manual.clientSecret } : undefined,
        stepUpScope: this.pendingScopes.get(server.id),
        openBrowser: (url) => openExternal(url),
        beginLoopback: (state, port, signal) => beginLoopback({ expectedState: state, port, signal }),
      });
      this.oauthSteps.set(server.id, outcome.steps);
      this.needsClient.delete(server.id);
      this.pendingScopes.delete(server.id);
      this.oauthSignedIn.add(server.id);
      if (server.enabled) return this.connectMcp(server.id);
      return this.serverView(server);
    } catch (error) {
      if (error instanceof McpOauthError) {
        this.oauthSteps.set(server.id, error.steps);
        if (error.needsClient) this.needsClient.add(server.id);
      }
      await this.rememberOauth(server);
      throw error;
    }
  }

  async signOutMcp(id: string): Promise<McpServerView> {
    this.requireExtensionConfig();
    const server = this.options.db.listMcpServers().find((item) => item.id === id);
    if (!server) throw new Error('That extension was not found.');
    await this.hub.disconnect(id);
    await this.options.secrets.delete(mcpOauthTokenAccount(id));
    this.oauthSignedIn.delete(id);
    this.oauthSteps.delete(id);
    this.needsClient.delete(id);
    this.pendingScopes.delete(id);
    return this.serverView(server);
  }

  respondApproval(id: string, choice: ApprovalChoice): void {
    const resolve = this.approvals.get(id);
    if (!resolve) throw new Error('That approval request has expired.');
    this.approvals.delete(id);
    resolve(choice);
  }

  listRoutines(agentId?: string): Routine[] {
    return this.options.db
      .listRoutines()
      .filter((routine) => !agentId || routine.agentId === agentId)
      .map(({ lastFiredMinute: _last, ...routine }) => routine);
  }

  saveRoutine(input: RoutineInput): Routine {
    this.requireAgentConfig();
    assertValidCron(input.cron);
    if (!input.name.trim() || !input.prompt.trim()) throw new Error('A routine needs a name and a prompt.');
    const existing = input.id ? this.options.db.getRoutine(input.id) : null;
    const agentId = input.agentId || existing?.agentId || (input.targetType === 'agent' ? input.targetId : this.defaultAgent().id);
    if (!this.options.db.getAgent(agentId)) throw new Error('That agent was not found.');
    const targetId = input.targetType === 'agent' ? agentId : input.targetId;
    if (input.targetType === 'room' && !this.options.db.getRoom(targetId)) throw new Error('That room was not found.');
    const routine = {
      id: input.id || randomId(),
      name: input.name.trim(),
      prompt: input.prompt,
      agentId,
      targetType: input.targetType,
      targetId,
      cron: input.cron.trim(),
      enabled: input.enabled,
      createdAt: existing?.createdAt ?? this.now(),
      lastFiredMinute: existing?.lastFiredMinute ?? null,
    };
    this.options.db.upsertRoutine(routine);
    const { lastFiredMinute: _last, ...publicRoutine } = routine;
    return publicRoutine;
  }

  deleteRoutine(id: string): void {
    this.requireAgentConfig();
    this.options.db.deleteRoutine(id);
  }

  async runRoutine(id: string): Promise<RoutineRun> {
    this.requireSession();
    this.requireWritableChat();
    const routine = this.options.db.getRoutine(id);
    if (!routine) throw new Error('That routine was not found.');
    return this.executeRoutine(routine);
  }

  listRoutineRuns(id: string): RoutineRun[] {
    return this.options.db.listRuns(id);
  }

  getSettings(): SettingsView {
    const provider = (this.options.db.getSetting('provider') ?? this.options.config.provider.default) as ProviderId;
    return {
      provider,
      model: this.options.db.getSetting('model') ?? defaultModelFor(provider, this.options.config.provider),
      temperature: storedTemperature(this.options.db.getSetting('temperature'), this.options.config.provider.temperature),
      tokenInspector: this.inspectorEnabled(),
      openaiBaseUrl: this.options.db.getSetting('openaiBaseUrl') ?? this.options.config.provider.openaiBaseUrl,
      anthropicBaseUrl: this.options.db.getSetting('anthropicBaseUrl') ?? this.options.config.provider.anthropicBaseUrl,
      genericBaseUrl: this.options.db.getSetting('genericBaseUrl') ?? this.options.config.provider.genericBaseUrl,
      keys: {
        openai: false,
        anthropic: false,
        generic: false,
        worker: false,
        agent: false,
      },
    };
  }

  async getSettingsAsync(): Promise<SettingsView> {
    const view = this.getSettings();
    view.keys = {
      openai: Boolean(await this.options.secrets.get('openaiApiKey')),
      anthropic: Boolean(await this.options.secrets.get('anthropicApiKey')),
      generic: Boolean(await this.options.secrets.get('genericApiKey')),
      worker: Boolean(await this.options.secrets.get('workerClientSecret')),
      agent: Boolean(await this.options.secrets.get('agentClientSecret')),
    };
    return view;
  }

  async saveSettings(input: SettingsInput): Promise<SettingsView> {
    if (input.temperature != null && (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)) {
      throw new Error('Temperature must be between 0 and 2.');
    }
    this.options.db.setSetting('provider', input.provider);
    this.options.db.setSetting('model', input.model.trim() || defaultModelFor(input.provider, this.options.config.provider));
    this.options.db.setSetting('temperature', input.temperature == null ? '' : String(input.temperature));
    this.options.db.setSetting('openaiBaseUrl', input.openaiBaseUrl.trim());
    this.options.db.setSetting('anthropicBaseUrl', input.anthropicBaseUrl.trim());
    this.options.db.setSetting('genericBaseUrl', input.genericBaseUrl.trim());
    await this.maybeSecret('openaiApiKey', input.openaiApiKey, input.clearKeys?.includes('openai'));
    await this.maybeSecret('anthropicApiKey', input.anthropicApiKey, input.clearKeys?.includes('anthropic'));
    await this.maybeSecret('genericApiKey', input.genericApiKey, input.clearKeys?.includes('generic'));
    await this.maybeSecret('workerClientSecret', input.workerClientSecret, input.clearKeys?.includes('worker'));
    await this.maybeSecret('agentClientSecret', input.agentClientSecret, input.clearKeys?.includes('agent'));
    return this.getSettingsAsync();
  }

  async listInspectedTokens(): Promise<InspectedToken[]> {
    this.assertInspector();
    this.requireSession();
    const tokens = [this.describeSession(), await this.describeAgent()];
    for (const audience of this.options.config.tokenExchange.audiences) {
      tokens.push(await this.describeAudience(audience));
    }
    return tokens;
  }

  async revealInspectedToken(id: string): Promise<string> {
    this.assertInspector();
    this.requireSession();
    if (id === 'session') return this.session?.accessToken ?? '';
    if (id === 'agent') {
      const cached = await this.readAgentToken();
      if (!cached?.accessToken) throw new Error('The AI Agent access token has not been minted yet.');
      return cached.accessToken;
    }
    const audience = this.audienceById(id);
    const cached = await this.cache.read(audience.audience);
    if (!cached?.accessToken) throw new Error('That audience has no exchanged token yet.');
    return cached.accessToken;
  }

  async reexchangeToken(id: string): Promise<InspectedToken> {
    this.assertInspector();
    this.requireSession();
    if (id === 'session') {
      await this.refreshSessionToken();
      return this.describeSession();
    }
    if (id === 'agent') {
      await this.options.secrets.delete(AGENT_TOKEN_ACCOUNT);
      this.agentActorToken = null;
      this.exchangeErrors.delete('agent');
      try {
        await this.actorAccessToken();
      } catch (error) {
        this.exchangeErrors.set('agent', redactSecrets(error instanceof Error ? error.message : String(error)));
      }
      return this.describeAgent();
    }
    const audience = this.audienceById(id);
    await this.cache.delete(audience.audience);
    this.exchangeErrors.delete(audience.audience);
    try {
      await this.tokenForAudience(audience.audience, audience.scope);
    } catch (error) {
      this.exchangeErrors.set(audience.audience, redactSecrets(error instanceof Error ? error.message : String(error)));
    }
    return this.describeAudience(audience);
  }

  async fireDueRoutines(date: Date): Promise<RoutineRun[]> {
    if (!this.session || this.firing) return [];
    if (this.currentFeatures().chat !== 'allow') return [];
    this.firing = true;
    const runs: RoutineRun[] = [];
    try {
      const key = minuteKey(date);
      for (const routine of this.options.db.listRoutines()) {
        if (!routine.enabled || routine.lastFiredMinute === key) continue;
        if (!cronMatches(routine.cron, date)) continue;
        this.options.db.markRoutineFired(routine.id, key);
        const run = await this.executeRoutine(routine);
        runs.push(run);
        this.emit({ type: 'routine-finished', run });
      }
    } finally {
      this.firing = false;
    }
    return runs;
  }

  private async executeRoutine(routine: Routine & { lastFiredMinute?: string | null }): Promise<RoutineRun> {
    const run: RoutineRun = {
      id: randomId(),
      routineId: routine.id,
      startedAt: this.now(),
      finishedAt: null,
      status: 'running',
      output: null,
      error: null,
    };
    this.options.db.insertRun(run);
    try {
      let output = '';
      if (routine.targetType === 'room') {
        const snapshot = this.openRoom(routine.targetId);
        this.options.db.insertMessage({
          id: randomId(),
          conversationId: snapshot.conversation.id,
          role: 'user',
          authorId: 'routine',
          authorName: routine.name,
          content: routine.prompt,
          createdAt: this.now(),
        });
        const room = this.options.db.getRoom(routine.targetId);
        const participants = (room?.agentIds ?? []).flatMap((agentId) => {
          const agent = this.options.db.getAgent(agentId);
          return agent ? [{ agent, room: room?.instructions }] : [];
        });
        output = await this.runGraph(snapshot.conversation.id, participants);
      } else {
        const agent = this.options.db.getAgent(routine.targetId) ?? this.defaultAgent();
        const now = this.now();
        const conversation = {
          id: randomId(),
          title: routine.name,
          kind: 'routine' as const,
          agentId: agent.id,
          roomId: null,
          createdAt: now,
          updatedAt: now,
        };
        this.options.db.insertConversation(conversation);
        this.options.db.insertMessage({
          id: randomId(),
          conversationId: conversation.id,
          role: 'user',
          authorId: 'routine',
          authorName: routine.name,
          content: routine.prompt,
          createdAt: now,
        });
        output = await this.runGraph(conversation.id, [{ agent }]);
      }
      const finished = { finishedAt: this.now(), status: 'success' as const, output, error: null };
      this.options.db.finishRun(run.id, finished);
      return { ...run, ...finished };
    } catch (error) {
      const finished = {
        finishedAt: this.now(),
        status: 'error' as const,
        output: null,
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      };
      this.options.db.finishRun(run.id, finished);
      return { ...run, ...finished };
    }
  }

  private async runGraph(conversationId: string, participants: { agent: AgentRow; room?: string }[]): Promise<string> {
    if (participants.length === 0 || this.cancelledConversations.has(conversationId)) return '';
    const settings = await this.getSettingsAsync();
    const apiKey = await this.apiKey(settings.provider);
    const baseUrl =
      settings.provider === 'openai'
        ? settings.openaiBaseUrl
        : settings.provider === 'anthropic'
          ? settings.anthropicBaseUrl
          : settings.provider === 'generic'
            ? settings.genericBaseUrl
            : undefined;
    const controller = new AbortController();
    this.activeTurn = controller;
    this.activeConversationId = conversationId;
    const runId = randomId();
    try {
      return await runAgentGraph({
        graph: this.agentGraph,
        checkpointer: this.checkpointer,
        threadId: `${conversationId}:${runId}`,
        runId,
        deps: {
          provider: settings.provider,
          model: settings.model,
          temperature: settings.temperature ?? undefined,
          reasoningEffort: this.options.config.provider.reasoningEffort,
          showReasoning: this.options.config.provider.showReasoning,
          apiKey,
          baseUrl,
          delayMs: this.options.mockDelayMs ?? 12,
          fetchImpl: this.options.fetchImpl,
          signal: controller.signal,
          now: () => this.now(),
          emit: (event) => this.emit(event),
          requestApproval: (request) => this.askApproval(request),
          rememberAlways: (serverId, toolName) => this.options.db.setToolPreference(serverId, toolName, 'always'),
          tokenForServer: (serverId) => this.tokenForServer(serverId),
          visibleTools: (tools, participant) => tools.filter((tool) => this.gateTool(tool, participant) === null),
          gateTool: (tool, participant) => this.gateTool(tool, participant),
          recordAdminAction: (agentId, action, detail) => {
            const prefix = `tool:${this.options.config.authorize.mcpServerId}/`;
            if (!action.startsWith(prefix)) return;
            this.audit(agentId, action, detail);
          },
          callTool: (tool, args, accessToken) => {
            if (isSkillReferenceTool(tool)) return Promise.resolve(this.readSkillReference(args));
            return this.hub.call(tool.serverId, tool.name, args, accessToken);
          },
          persistMessage: (message) => {
            this.options.db.insertMessage({
              id: message.id,
              conversationId,
              role: 'assistant',
              authorId: message.authorId,
              authorName: message.authorName,
              content: message.content,
              reasoning: message.reasoning,
              reasoningMs: message.reasoningMs,
              createdAt: this.now(),
            });
          },
          persistTool: (tool) => this.options.db.insertToolInvocation(tool),
        },
        initial: {
          messages: this.providerHistory(conversationId),
          participants: participants.map((item) => this.participant(item.agent, item.room)),
          availableTools: this.graphTools(),
          riskAction: this.risk?.action ?? 'allow',
          remembered: this.rememberedMap(),
          agentIndex: 0,
          rounds: 0,
          toolIndex: 0,
          conversationId,
          cancelled: false,
          finalText: '',
        },
      });
    } finally {
      if (this.activeTurn === controller) {
        this.activeTurn = null;
        this.activeConversationId = '';
      }
    }
  }

  private participant(agent: AgentRow, room?: string): GraphParticipant {
    const risk = this.risk
      ? renderRiskContext(this.risk, agent.nameFromBranding ? this.options.branding.agentName : agent.name)
      : undefined;
    return {
      id: agent.id,
      name: agent.name,
      appName: this.options.branding.appName,
      agentName: agent.name,
      enterprise: this.options.config.enterpriseInstructions,
      persona: agent.instructions ?? (agent.nameFromBranding ? this.options.branding.persona : emptyFields()),
      user: agent.userInstructions ?? emptyFields(),
      room,
      risk,
      skillIds: this.usableSkills(agent).map((skill) => skill.id),
      skills: this.skillPrompt(agent),
    };
  }

  private rememberedMap(): Record<string, 'always' | 'deny'> {
    const remembered: Record<string, 'always' | 'deny'> = {};
    for (const tool of this.graphTools()) {
      const preference = this.options.db.getToolPreference(tool.serverId, tool.name);
      if (preference) remembered[`${tool.serverId}\0${tool.name}`] = preference;
    }
    return remembered;
  }

  private async tokenForServer(serverId: string): Promise<string> {
    const server = this.options.db.listMcpServers().find((item) => item.id === serverId);
    if (!server) return '';
    return (await this.accessTokenForServer(server)) ?? '';
  }

  private async accessTokenForServer(server: McpServerRow): Promise<string | undefined> {
    if (server.id === this.options.config.authorize.mcpServerId) {
      this.requireAdmin();
      if (!this.currentFeatures().pingoneTools) {
        throw new Error('Authorize turned PingOne tools off for this session.');
      }
      if (this.options.config.tenant.mode === 'mock') {
        return this.mockToken('worker', 'worker', 'authorize').accessToken;
      }
      return this.workerAccessToken();
    }
    if (server.audience.trim()) return this.tokenForAudience(server.audience, server.scope);
    if (server.transport === 'http' || server.transport === 'sse') return this.currentOauthAccessToken(server.id);
    return undefined;
  }

  private gateTool(tool: RuntimeTool, participant: GraphParticipant | undefined): string | null {
    const features = this.currentFeatures();
    if (!features.tools) {
      const level = features.chat === 'locked' ? 'HIGH' : (this.risk?.level ?? 'UNKNOWN');
      if (level === 'MEDIUM' || level === 'HIGH') {
        return `Tool invocation is turned off because Protect scored this session ${level}.`;
      }
      return 'Authorize policy disabled tool invocation for this session.';
    }
    if (isSkillReferenceTool(tool) || tool.serverId === this.options.config.authorize.mcpServerId) {
      return skillReferenceDenied({
        serverId: tool.serverId,
        name: tool.name,
        mcpServerId: this.options.config.authorize.mcpServerId,
        admin: this.isAdmin(),
        adminGroup: this.options.config.access.adminGroup,
        pingoneTools: features.pingoneTools,
        skillIds: participant?.skillIds ?? [],
      });
    }
    if ((!features.mcpWrites || features.chat !== 'allow') && !tool.readOnlyHint) {
      return 'Authorize policy disabled MCP writes for this session.';
    }
    return null;
  }

  private graphTools(): RuntimeTool[] {
    return [this.skillReferenceTool(), ...this.hub.allTools()];
  }

  private skillReferenceTool(): RuntimeTool {
    const fields = skillReferenceToolFields(this.pingoneBundle?.files ?? []);
    return {
      key: toolKey(SKILL_REFERENCE_SERVER_ID, SKILL_REFERENCE_TOOL),
      serverId: SKILL_REFERENCE_SERVER_ID,
      serverName: 'PingOne skill',
      name: SKILL_REFERENCE_TOOL,
      description: fields.description,
      inputSchema: fields.inputSchema,
      readOnlyHint: true,
      ...(fields.strict ? { strict: true } : {}),
    };
  }

  private readSkillReference(args: unknown): string {
    if (process.env.AGENT_DEBUG === '1') console.error(`[agent] read_skill_reference args ${JSON.stringify(args)}`);
    if (!this.pingoneBundle) throw new Error('The PingOne Authorize skill bundle is not installed.');
    const name = args && typeof args === 'object' && 'name' in args && typeof args.name === 'string' ? args.name : '';
    return readSkillReferenceFile(this.pingoneBundle.root, name);
  }

  private isAdmin(): boolean {
    return isAdmin(this.session?.groups ?? [], this.options.config.access.adminGroup);
  }

  private requireAdmin(): void {
    this.requireSession();
    if (!this.isAdmin()) {
      throw new Error(`That action is limited to the ${this.options.config.access.adminGroup} group.`);
    }
  }

  private requirePolicy(): void {
    this.requireAdmin();
    if (!this.currentFeatures().policyTab) {
      throw new Error('Authorize policy hid the Policy tab for this session.');
    }
  }

  private mockGroupNames(): string[] {
    return this.mockAdmin ? [this.options.config.access.adminGroup] : ['Employees'];
  }

  private groupsForTokens(tokens: { accessToken: string; idToken?: string }): string[] {
    const claim = this.options.config.access.groupsClaim;
    const fromAccess = groupsFromClaims(decodeJwtPayload(tokens.accessToken), claim);
    if (fromAccess.length > 0) return fromAccess;
    if (tokens.idToken) return groupsFromClaims(decodeJwtPayload(tokens.idToken), claim);
    return [];
  }

  private currentFeatures(): FeatureDecision {
    if (!this.session || this.stepUpRequired) return failClosed(this.now());
    return this.features;
  }

  private decisionInput(): DecisionInput {
    return {
      groups: this.session?.groups ?? [],
      riskLevel: this.risk?.level ?? 'UNKNOWN',
      riskAction: this.risk?.action ?? 'allow',
    };
  }

  private decisionEndpointId(): string {
    if (this.options.config.tenant.mode !== 'pingone') return '';
    const saved = this.options.db.getSetting('authorize.decisionEndpointId')?.trim() ?? '';
    return saved || this.options.config.authorize.decisionEndpointId.trim();
  }

  private policiesForDecision(): AuthorizePolicy[] {
    return policiesForEvaluation(
      this.options.db.listPolicies(),
      scaffoldPolicies(this.options.config.access.adminGroup, this.now(), 'starter'),
      this.decisionEndpointId(),
    );
  }

  private sessionRestriction() {
    if (!this.session || this.stepUpRequired) return null;
    return explainRestriction(this.currentFeatures(), this.decisionInput(), this.options.db.listPolicies().length);
  }

  private applyFeatures(decision: FeatureDecision, key: string): void {
    const next = applyLiveRiskGates(decision, this.decisionInput(), this.isAdmin(), this.options.config.protect.enabled);
    this.features = next;
    this.decisionCache = { key, at: this.now(), decision: next };
  }

  private requireWritableChat(): void {
    if (this.currentFeatures().chat === 'locked') {
      throw new Error('Chat is locked because Protect scored this session HIGH.');
    }
    if (this.currentFeatures().chat === 'read_only') {
      throw new Error('Authorize policy made this session read-only.');
    }
  }

  private requireAgentConfig(): void {
    this.requireSession();
    if (!this.currentFeatures().agentConfig) {
      throw new Error('Agent configuration is locked because Protect scored this session HIGH.');
    }
  }

  private requireExtensionConfig(): void {
    this.requireSession();
    if (!this.currentFeatures().extensionConfig) {
      throw new Error('Extension configuration is locked because Protect scored this session HIGH.');
    }
  }

  private ensureBuiltinSkill(): void {
    const existing = this.options.db.getSkill(PINGONE_SKILL_ID);
    this.options.db.upsertSkill({
      id: PINGONE_SKILL_ID,
      name: 'PingOne',
      description: 'Administer PingOne Authorize through the PingOne MCP server.',
      instructions: pingoneSkillInstructions(this.options.config.access.adminGroup),
      files: existing?.files ?? [],
      requiredGroups: [],
      requiresAdmin: true,
      builtin: true,
      enabled: existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? this.now(),
    });
  }

  private skillMatchesSession(skill: SkillRow): boolean {
    if (skill.requiresAdmin) return this.isAdmin();
    if (skill.requiredGroups.length === 0) return true;
    const groups = this.session?.groups ?? [];
    return skill.requiredGroups.some((group) => groups.includes(group));
  }

  private skillVisible(skill: SkillRow): boolean {
    return this.skillMatchesSession(skill);
  }

  private skillUsable(skill: SkillRow): boolean {
    return skill.enabled && this.skillMatchesSession(skill);
  }

  private skillView(skill: SkillRow, assignedIds: string[]): SkillView {
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      requiredGroups: skill.requiredGroups,
      requiresAdmin: skill.requiresAdmin,
      builtin: skill.builtin,
      enabled: skill.enabled,
      assigned: assignedIds.includes(skill.id),
    };
  }

  private storeSkillDraft(draft: SkillDraft): SkillView {
    const size = draft.instructions.length + draft.files.reduce((sum, file) => sum + file.path.length + file.text.length, 0);
    if (size > 200_000) throw new Error('That skill is larger than 200 KB.');
    if (!draft.name.trim()) throw new Error('Give the skill a name.');
    if (!draft.instructions.trim()) throw new Error('The skill needs instructions.');
    const skill: SkillRow = {
      id: randomId(),
      name: draft.name.trim(),
      description: draft.description.trim(),
      instructions: draft.instructions.trim(),
      files: draft.files,
      requiredGroups: draft.requiredGroups,
      requiresAdmin: false,
      builtin: false,
      enabled: true,
      createdAt: this.now(),
    };
    this.options.db.upsertSkill(skill);
    return this.skillView(skill, []);
  }

  private usableSkills(agent: AgentRow): SkillRow[] {
    return agent.skillIds.flatMap((id) => {
      const skill = this.options.db.getSkill(id);
      return skill && this.skillUsable(skill) ? [skill] : [];
    });
  }

  private skillPrompt(agent: AgentRow): string {
    return this.usableSkills(agent)
      .map((skill) => {
        const head = `Skill: ${skill.name}\n${skill.description}\n${skill.instructions}`;
        if (skill.id === PINGONE_SKILL_ID) {
          return this.pingoneBundle ? `${head}\n\n${pingoneAuthorizeSkillLayer(this.pingoneBundle)}` : head;
        }
        const files = skill.files.map((file) => `\n\nFile ${file.path}:\n${file.text}`).join('');
        return `${head}${files}`;
      })
      .join('\n\n');
  }

  private audit(agentId: string | null, action: string, detail: string): void {
    this.options.db.insertAudit({
      id: randomId(),
      at: this.now(),
      userId: this.session?.userId ?? '',
      username: this.session?.username ?? '',
      agentId,
      action,
      detail,
    });
  }

  private async pullRemotePolicies(): Promise<void> {
    const token = await this.workerAccessToken();
    const remote = await listRemotePolicies(this.options.config, token, this.authorize);
    const starters = scaffoldPolicies(this.options.config.access.adminGroup, this.now(), this.session?.username ?? '');
    const { dropIds } = reconcilePolicyCache(this.options.db.listPolicies(), remote, starters);
    for (const id of dropIds) this.options.db.deletePolicy(id);
    const local = this.options.db.listPolicies();
    for (const item of remote) {
      const marker = parseScaffoldMarker(item.description);
      const match = local.find((policy) => policy.remoteId === item.id || policy.id === marker?.id || policy.name === item.name);
      if (match) {
        this.options.db.upsertPolicy({
          ...match,
          enabled: item.enabled,
          remoteId: item.id,
          updatedAt: item.updatedAt ?? match.updatedAt,
          when: Object.keys(match.when).length > 0 ? match.when : (marker?.when ?? match.when),
          effect: Object.keys(match.effect).length > 0 ? match.effect : (marker?.effect ?? match.effect),
        });
        continue;
      }
      this.options.db.upsertPolicy({
        id: marker?.id ?? item.id,
        name: item.name,
        description: item.description,
        enabled: item.enabled,
        updatedAt: item.updatedAt,
        updatedBy: null,
        scaffold: Boolean(marker) || item.description.includes(SCAFFOLD_MARKER),
        remoteId: item.id,
        when: marker?.when ?? {},
        effect: marker?.effect ?? {},
      });
    }
  }

  private async confirmScaffold(incoming: AuthorizePolicy[]): Promise<PolicyScaffoldResult> {
    const epoch = this.policyEpoch;
    if (this.options.config.tenant.mode === 'pingone') await this.pullRemotePolicies();
    if (epoch !== this.policyEpoch) return this.abandonedScaffold(incoming);
    const existing = this.options.db.listPolicies();
    const merged = mergeScaffold(existing, incoming);
    const preview = incoming.map(policyView);
    for (const policy of merged.created) {
      if (epoch !== this.policyEpoch) return this.abandonedScaffold(incoming);
      this.options.db.upsertPolicy(policy);
    }
    const pending = this.options.db.listPolicies().filter((policy) => policy.scaffold && !policy.remoteId);
    const posted = await this.pushScaffold(pending, epoch);
    if (epoch !== this.policyEpoch) return this.abandonedScaffold(incoming);
    const warning = this.options.config.tenant.mode === 'pingone' ? await this.provisionRealPolicies(epoch) : undefined;
    if (epoch !== this.policyEpoch) return this.abandonedScaffold(incoming);
    const created = posted.length > 0 ? posted : merged.created;
    if (created.length > 0) {
      this.audit(null, 'policy:scaffold', created.map((policy) => policy.name).join(', '));
    }
    this.decisionCache = null;
    await this.refreshFeatures();
    return { preview, created: created.map(policyView), policies: this.options.db.listPolicies().map(policyView), warning };
  }

  private abandonedScaffold(incoming: AuthorizePolicy[]): PolicyScaffoldResult {
    return {
      preview: incoming.map(policyView),
      created: [],
      policies: this.options.db.listPolicies().map(policyView),
    };
  }

  private async provisionRealPolicies(epoch: number): Promise<string | undefined> {
    if (epoch !== this.policyEpoch) return;
    const token = await this.workerAccessToken();
    const result = await provisionAuthorize({
      config: this.options.config,
      accessToken: token,
      client: this.authorize,
      store: {
        get: (kind, name) => this.options.db.getTfObject(kind, name),
        put: (kind, name, remoteId, contentHash) => this.options.db.upsertTfObject(kind, name, remoteId, contentHash),
      },
      adminGroup: this.options.config.access.adminGroup,
      delegations: this.options.config.authorize.delegations,
      alwaysCurrent: this.options.config.authorize.alwaysCurrent,
      shouldContinue: () => epoch === this.policyEpoch,
      log: this.options.log,
      logPath: this.options.logPath,
    });
    if (epoch !== this.policyEpoch || !result.decisionEndpointId) return result.warning;
    this.options.db.setSetting('authorize.decisionEndpointId', result.decisionEndpointId);
    this.options.config.authorize.decisionEndpointId = result.decisionEndpointId;
    this.persistDecisionEndpoint(result.decisionEndpointId);
    for (const policy of result.policies) {
      if (epoch !== this.policyEpoch) return result.warning;
      this.options.db.upsertPolicy(policy);
    }
    return result.warning;
  }

  private persistDecisionEndpoint(id: string): void {
    const path = this.options.configPath;
    if (!path) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { authorize?: Record<string, unknown> };
      raw.authorize = { ...(raw.authorize ?? {}), decisionEndpointId: id };
      writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
    } catch {
      // The settings row and the running config already hold the id.
    }
  }

  private async decisionCall(input: DecisionInput): Promise<DecisionCall | null> {
    if (!this.session) return null;
    const accessToken = (await this.subjectToken().catch(() => '')).trim();
    const txToken = (await this.delegationToken()).trim();
    if (!decisionTokensReady(accessToken, txToken)) return null;
    return {
      ...input,
      userId: this.session.userId,
      username: this.session.username,
      accessToken,
      txToken,
      adminGroup: this.options.config.access.adminGroup,
      parentName: 'EnterpriseAgent',
    };
  }

  private async delegationToken(): Promise<string> {
    const configured = this.options.config.authorize.delegationAudience.trim();
    const match = this.options.config.tokenExchange.audiences.find((item) => item.audience === configured);
    const audience = match?.audience || this.options.config.tokenExchange.audiences[0]?.audience || '';
    if (!audience) return '';
    const scope = match?.scope || this.options.config.tokenExchange.audiences.find((item) => item.audience === audience)?.scope || '';
    try {
      return await this.tokenForAudience(audience, scope);
    } catch {
      return '';
    }
  }

  private async pushScaffold(pending: AuthorizePolicy[], epoch: number): Promise<AuthorizePolicy[]> {
    if (pending.length === 0 || this.options.config.tenant.mode !== 'pingone') return [];
    if (epoch !== this.policyEpoch) return [];
    const token = await this.workerAccessToken();
    const synced = await syncRemoteScaffold(
      this.options.config,
      token,
      pending,
      this.authorize,
      (policy) => {
        if (epoch !== this.policyEpoch) return;
        this.options.db.upsertPolicy(policy);
      },
      () => epoch === this.policyEpoch,
    );
    return epoch === this.policyEpoch ? synced.created : [];
  }

  private async refreshFeatures(): Promise<void> {
    if (!this.session) {
      this.features = failClosed(this.now());
      this.decisionCache = null;
      return;
    }
    const input = this.decisionInput();
    const key = decisionCacheKey(input);
    const cached = this.decisionCache;
    if (cached && cached.key === key && this.now() - cached.at < this.options.config.authorize.cacheMs) {
      this.features = cached.decision;
      return;
    }
    const stored = this.options.db.listPolicies();
    const starters = scaffoldPolicies(this.options.config.access.adminGroup, this.now(), 'starter');
    const endpoint = this.decisionEndpointId();
    const local = evaluatePolicies(this.policiesForDecision(), input, this.now());
    if (!endpoint) {
      this.applyFeatures(local, key);
      return;
    }
    const call = await this.decisionCall(input);
    if (!call) {
      this.applyFeatures(failClosed(this.now()), key);
      return;
    }
    try {
      const token = await this.workerAccessToken();
      const body = await postDecision(this.options.config, token, call, this.authorize);
      const remote = featuresFromAuthorize(body, this.now());
      const fallback = stored.length === 0 ? evaluatePolicies(starters, input, this.now()) : local;
      this.applyFeatures(remote ?? fallback, key);
    } catch {
      this.applyFeatures(failClosed(this.now()), key);
    }
  }

  private askApproval(request: ApprovalRequest): Promise<ApprovalChoice> {
    return new Promise((resolve) => {
      this.approvals.set(request.id, resolve);
      this.emit({ type: 'approval-required', request });
    });
  }

  private providerHistory(conversationId: string): ProviderMessage[] {
    const history: ProviderMessage[] = [];
    for (const message of this.options.db.listMessages(conversationId)) {
      if (message.role === 'user') {
        const attachments = message.attachments.flatMap((item) => {
          const stored = this.options.db.getAttachment(item.id);
          return stored ? [this.readAttachment(stored)] : [];
        });
        let content = message.content;
        for (const attachment of attachments) {
          if (attachment.text) {
            content += `\n\n<untrusted-attachment name="${attachment.name}">\n${attachment.text}\n</untrusted-attachment>`;
          } else {
            content += `\n\n<untrusted-attachment name="${attachment.name}" mime="${attachment.mime}" />`;
          }
        }
        history.push({ role: 'user', content, attachments });
        continue;
      }
      if (message.role !== 'assistant') continue;
      const toolCalls = message.tools.map((tool) => ({
        id: tool.id,
        name: toolKey(tool.serverId, tool.toolName),
        arguments: JSON.stringify(tool.args ?? {}),
      }));
      history.push({ role: 'assistant', content: message.content, toolCalls });
      for (const tool of message.tools) {
        history.push({
          role: 'tool',
          toolCallId: tool.id,
          name: toolKey(tool.serverId, tool.toolName),
          content: tool.result ?? '',
        });
      }
    }
    return history;
  }

  private readAttachment(attachment: Attachment & { path: string }): {
    name: string;
    mime: string;
    text?: string;
    dataBase64?: string;
  } {
    const bytes = readFileSync(attachment.path);
    if (attachment.mime.startsWith('image/') && bytes.byteLength < 1_500_000) {
      return { name: attachment.name, mime: attachment.mime, dataBase64: bytes.toString('base64') };
    }
    if (attachment.mime.startsWith('text/') || attachment.mime === 'application/json') {
      return { name: attachment.name, mime: attachment.mime, text: bytes.toString('utf8').slice(0, 32_000) };
    }
    return { name: attachment.name, mime: attachment.mime };
  }

  private async advance(flow: FlowSnapshot, signals: string): Promise<AppState> {
    this.flow = flow;
    const finished = flow.status === 'COMPLETED' || flow.status === 'COMPLETED_ACCEPTED' || Boolean(flow.authorizeResponse?.code);
    if (finished && !flow.authorizeResponse?.code && !flow.resumeUrl) {
      this.login = { phase: 'error', status: flow.status, message: signInStepMessage(flow) };
      return this.state();
    }
    if (finished) {
      const username = flow.user?.username || 'user';
      return this.completeLogin({
        userId: flow.user?.id || `external:${username}`,
        username,
        signals,
        mfaSatisfied: this.mfaSatisfied,
        obtainTokens: async () => {
          const code = await this.pi.authorizationCode(flow);
          if (this.pkce && code.state && code.state !== this.pkce.state) {
            throw new Error('The authorization response failed the state check.');
          }
          if (!this.pkce) throw new Error('The sign-in challenge is missing. Start again.');
          return this.pi.exchangeCode({
            code: code.code,
            verifier: this.pkce.verifier,
            redirectUri: this.options.config.tenant.redirectUri,
          });
        },
      });
    }
    if (MFA_STATUSES.has(flow.status)) this.mfaSatisfied = false;
    const view = this.viewForFlow(flow);
    this.login = view;
    return this.state();
  }

  private viewForFlow(flow: FlowSnapshot): LoginView {
    if (
      flow.status === 'PUSH_CONFIRMATION_REQUIRED' ||
      flow.status === 'PUSH_CONFIRMATION_TIMED_OUT' ||
      flow.status === 'ASSERTION_REQUIRED'
    ) {
      return { phase: 'error', status: flow.status, message: signInStepMessage(flow) };
    }
    if (flow.links['otp.check'] || flow.status === 'OTP_REQUIRED' || flow.status === 'MFA_REQUIRED') {
      return { phase: 'otp', status: flow.status, message: 'Enter the verification code from your organization.' };
    }
    if (flow.links['device.select'] || flow.status === 'DEVICE_SELECTION_REQUIRED') {
      return { phase: 'device', status: flow.status, devices: flow.devices, message: 'Choose a verification device.' };
    }
    if (acceptsCredentialSubmit(flow)) {
      return { phase: 'credentials', status: flow.status };
    }
    return { phase: 'error', status: flow.status, message: signInStepMessage(flow) };
  }

  private async completeLogin(input: PendingLogin & { mfaSatisfied: boolean }): Promise<AppState> {
    const risk = await this.evaluateRisk(input.userId, input.username, input.signals);
    this.risk = risk;
    this.options.db.setSetting('risk', JSON.stringify(risk));
    if (risk.action === 'block') {
      await this.markRisk('FAILED');
      this.session = null;
      await this.options.secrets.delete('session');
      this.stepUpRequired = false;
      this.login = { phase: 'blocked', message: risk.summary };
      return this.state();
    }
    if (risk.action === 'step_up_mfa' && !input.mfaSatisfied) {
      if (this.options.config.tenant.mode === 'mock') {
        this.pendingLogin = input;
        this.stepUpRequired = true;
        this.login = {
          phase: 'otp',
          stepUp: true,
          message: 'Step-up verification is required. In mock mode, enter any 6-digit code.',
        };
        return this.state();
      }
      if (this.stepUpRestarted || !this.options.config.tenant.login.stepUpAcrValues) {
        this.login = {
          phase: 'error',
          stepUp: true,
          message: this.options.config.tenant.login.stepUpAcrValues
            ? 'The sign-on policy did not issue an MFA challenge. Update the PingOne sign-on policy so step-up has a real factor.'
            : 'Risk policy requires step-up MFA. Set tenant.login.stepUpAcrValues and require that factor in the sign-on policy.',
        };
        this.stepUpRequired = true;
        return this.state();
      }
      this.stepUpRestarted = true;
      this.pkce = await createPkce();
      this.mfaSatisfied = false;
      this.flow = await this.pi.startAuthorize({
        redirectUri: this.options.config.tenant.redirectUri,
        scopes: this.options.config.tenant.scopes,
        challenge: this.pkce.challenge,
        state: this.pkce.state,
        acrValues: this.options.config.tenant.login.stepUpAcrValues,
        loginHint: input.username,
      });
      this.stepUpRequired = true;
      this.login = { ...this.viewForFlow(this.flow), stepUp: true };
      return this.state();
    }
    const tokens = await input.obtainTokens();
    await this.activate(tokens, input.userId, input.username);
    await this.markRisk('SUCCESS');
    return this.state();
  }

  reloadProtectSettings(): void {
    this.syncProtectSettingsFromDisk();
    if (!this.session) {
      this.stopProtectPoll();
      return;
    }
    this.scheduleProtectPoll();
  }

  nudgeProtectPoll(): void {
    if (!this.session || this.shouldPauseProtect()) return;
    void this.runProtectPoll(false);
  }

  private syncProtectSettingsFromDisk(): void {
    const path = this.options.configPath;
    if (!path) return;
    try {
      const next = loadEnterprise(path);
      this.options.config.protect.pollIntervalSeconds = next.protect.pollIntervalSeconds;
      this.options.config.protect.pauseWhenHidden = next.protect.pauseWhenHidden;
    } catch {
      // Keep the interval already in memory when the file cannot be read.
    }
  }

  private protectIntervalSeconds(): number {
    return this.options.config.protect.pollIntervalSeconds;
  }

  private shouldPauseProtect(): boolean {
    if (!this.options.config.protect.enabled || !this.options.config.protect.pauseWhenHidden) return false;
    if (!this.options.protectActive) return false;
    return !this.options.protectActive();
  }

  private scheduleProtectPoll(): void {
    this.protectCancel?.();
    this.protectCancel = null;
    this.syncProtectSettingsFromDisk();
    const delay = nextProtectDelayMs(this.protectIntervalSeconds(), this.protectRetryAfterSeconds);
    this.protectRetryAfterSeconds = null;
    if (delay == null || !this.session || !this.options.config.protect.enabled) return;
    const schedule = this.options.schedule ?? defaultProtectSchedule;
    this.protectCancel = schedule(delay, () => this.runProtectPoll(false));
  }

  private stopProtectPoll(): void {
    this.protectGeneration += 1;
    this.protectQueued = false;
    this.protectRetryAfterSeconds = null;
    this.protectCancel?.();
    this.protectCancel = null;
  }

  private async runProtectPoll(force: boolean): Promise<void> {
    if (this.protectPollTask) {
      this.protectQueued = true;
      while (this.protectPollTask) await this.protectPollTask;
      return;
    }
    const generation = this.protectGeneration;
    const task = this.executeProtectPoll(generation, force);
    this.protectPollTask = task;
    try {
      await task;
    } finally {
      if (this.protectPollTask === task) this.protectPollTask = null;
    }
    if (generation !== this.protectGeneration || !this.session) return;
    if (this.protectQueued) {
      this.protectQueued = false;
      await this.runProtectPoll(false);
      return;
    }
    this.scheduleProtectPoll();
  }

  private async executeProtectPoll(generation: number, force: boolean): Promise<void> {
    if (!this.session || !this.options.config.protect.enabled) return;
    if (!force && nextProtectDelayMs(this.protectIntervalSeconds()) == null) return;
    if (!(await this.ensureSessionForPoll())) return;
    if (generation !== this.protectGeneration || !this.session) return;
    if (!force && this.shouldPauseProtect()) return;
    const signals = await this.freshSignals();
    if (generation !== this.protectGeneration || !this.session) return;
    try {
      const next = await this.evaluateRisk(this.session.userId, this.session.username, signals);
      if (generation !== this.protectGeneration || !this.session) return;
      await this.applyPolledRisk(next);
    } catch (error) {
      if (generation !== this.protectGeneration || !this.session) return;
      const kind = classifyProtectPollFailure(error);
      if (kind === 'rate-limit') {
        this.protectRetryAfterSeconds = error instanceof RiskEvaluationError ? error.retryAfterSeconds : null;
        return;
      }
      if (kind === 'transient' && this.risk) return;
      await this.applyPolledRisk(unscoredRisk(this.options.config.protect.policy, this.now(), Boolean(signals)));
    }
  }

  private async ensureSessionForPoll(): Promise<boolean> {
    if (!this.session) return false;
    const freshness = classifyAccessToken(this.session, this.now());
    if (freshness === 'valid') return true;
    if (freshness === 'refresh') {
      try {
        await this.refreshSessionToken();
        return Boolean(this.session);
      } catch {
        this.stopProtectPoll();
        return false;
      }
    }
    this.stopProtectPoll();
    return false;
  }

  private async freshSignals(): Promise<string> {
    const collect = this.options.collectSignals;
    if (!collect) return this.pendingSignals;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const next = await Promise.race([
        collect(),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve(''), 4_000);
        }),
      ]);
      if (next) this.pendingSignals = next;
    } catch {
      // A signals failure keeps the payload from sign-in.
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this.pendingSignals;
  }

  private async applyPolledRisk(next: RiskView): Promise<void> {
    const levelChanged = this.risk?.level !== next.level;
    this.risk = next;
    this.options.db.setSetting('risk', JSON.stringify(next));
    if (levelChanged) this.decisionCache = null;
    await this.refreshFeatures();
    this.options.onState?.(this.state());
  }

  private async evaluateRisk(userId: string, username: string, signals: string): Promise<RiskView> {
    const evaluatedAt = this.now();
    if (!this.options.config.protect.enabled) {
      return {
        level: 'LOW',
        action: 'allow',
        reasons: [],
        summary: 'Protect is turned off in enterprise config. No risk evaluation was run.',
        signalsCollected: Boolean(signals),
        evaluatedAt,
      };
    }
    if (this.options.config.tenant.mode === 'mock') {
      const payload = mockRiskPayload(this.scenario);
      const reasons = extractRiskReasons(payload.details);
      const action = decideRisk(this.options.config.protect.policy, payload.level, reasons);
      return {
        evaluationId: `mock-${randomId()}`,
        level: payload.level,
        action,
        reasons,
        summary: summarizeRisk(payload.level, action, reasons),
        signalsCollected: Boolean(signals),
        evaluatedAt,
      };
    }
    const ip = await this.clientIp();
    const worker = await this.workerAccessToken();
    try {
      const evaluation = await createRiskEvaluation({
        url: riskEvaluationsUrl(this.options.config),
        accessToken: worker,
        riskPolicySetId: this.options.config.protect.riskPolicySetId || undefined,
        fetchImpl: this.options.fetchImpl,
        event: buildRiskEvent({
          ip,
          userId,
          username,
          userType: this.options.config.protect.userType,
          userAgent: `${this.options.branding.appName}/${this.options.version ?? '0.1.0'} (${process.platform})`,
          targetId: this.options.config.tenant.clientId || 'desktop-agent',
          targetName: this.options.branding.appName,
          signals: signals || undefined,
        }),
      });
      const reasons = extractRiskReasons(evaluation.details);
      const level = riskLevel(evaluation.level);
      const action = decideRisk(this.options.config.protect.policy, level, reasons);
      return {
        evaluationId: evaluation.id,
        level,
        action,
        reasons,
        summary: summarizeRisk(level, action, reasons),
        signalsCollected: Boolean(signals),
        evaluatedAt,
      };
    } catch (error) {
      if (ip) throw error;
      return unscoredRisk(this.options.config.protect.policy, evaluatedAt, Boolean(signals));
    }
  }

  private async activate(tokens: TokenSet, userId: string, username: string): Promise<void> {
    this.session = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      expiresAt: tokens.expiresAt,
      tokenType: tokens.tokenType,
      userId,
      username,
      groups: this.groupsForTokens(tokens),
    };
    await this.options.secrets.set('session', JSON.stringify(this.session));
    await this.refreshFeatures();
    this.login = { phase: 'idle' };
    this.stepUpRequired = false;
    this.pendingLogin = null;
    this.flow = null;
    this.stepUpRestarted = false;
    await this.exchangeAudiences();
    this.scheduleProtectPoll();
  }

  private async exchangeAudiences(): Promise<void> {
    if (!this.session) return;
    try {
      await this.actorAccessToken();
      this.exchangeErrors.delete('agent');
    } catch (error) {
      this.exchangeErrors.set('agent', error instanceof Error ? error.message : String(error));
    }
    for (const audience of this.options.config.tokenExchange.audiences) {
      try {
        await this.tokenForAudience(audience.audience, audience.scope);
        this.exchangeErrors.delete(audience.audience);
      } catch (error) {
        this.exchangeErrors.set(audience.audience, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async tokenForAudience(audience: string, scope: string): Promise<string> {
    if (!this.session) throw new Error('Sign in before requesting an audience token.');
    const actorToken = await this.actorAccessToken();
    if (this.options.config.tenant.mode === 'mock') {
      const cached = await this.cache.get(audience);
      if (cached) return cached.accessToken;
      const token = this.mockToken(this.session.userId, audience, scope, true);
      await this.cache.put(audience, token);
      return token.accessToken;
    }
    const subject = await this.subjectToken();
    const client = await this.exchangeClient();
    const token = await getOrExchange({
      cache: this.cache,
      tokenEndpoint: tokenEndpoint(this.options.config),
      subjectToken: subject,
      audience,
      scope,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      actorToken,
      fetchImpl: this.options.fetchImpl,
      now: () => this.now(),
    });
    return token.accessToken;
  }

  private async exchangeClient(): Promise<{ clientId: string; clientSecret: string }> {
    const configuredId = this.options.config.tokenExchange.clientId.trim();
    const agentSecret = (await this.options.secrets.get('agentClientSecret'))?.trim() ?? '';
    if (configuredId && agentSecret) return { clientId: configuredId, clientSecret: agentSecret };
    const workerId = this.env('PINGONE_WORKER_CLIENT_ID') || configuredId;
    const workerSecret = (await this.options.secrets.get('workerClientSecret'))?.trim() ?? '';
    if (workerId && workerSecret) return { clientId: workerId, clientSecret: workerSecret };
    throw new Error(
      'Configure tokenExchange.clientId and PINGONE_AGENT_CLIENT_SECRET for token exchange. When the AI Agent client is not configured, the Protect worker id and secret are used.',
    );
  }

  private async actorAccessToken(): Promise<string> {
    const cached = await this.readAgentToken();
    if (cached && classifyAccessToken(cached, this.now()) === 'valid') {
      this.agentActorToken = cached;
      return cached.accessToken;
    }
    const fresh =
      this.options.config.tenant.mode === 'mock'
        ? this.mockAgentToken()
        : await this.fetchAgentToken();
    this.agentActorToken = fresh;
    await this.options.secrets.set(AGENT_TOKEN_ACCOUNT, JSON.stringify(fresh));
    return fresh.accessToken;
  }

  private async fetchAgentToken(): Promise<TokenSet> {
    const client = await this.exchangeClient();
    return fetchClientCredentials({
      tokenEndpoint: tokenEndpoint(this.options.config),
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      fetchImpl: this.options.fetchImpl,
      now: () => this.now(),
    });
  }

  private async readAgentToken(): Promise<TokenSet | null> {
    if (this.agentActorToken) return this.agentActorToken;
    const raw = await this.options.secrets.get(AGENT_TOKEN_ACCOUNT);
    if (!raw) return null;
    return JSON.parse(raw) as TokenSet;
  }

  private async subjectToken(): Promise<string> {
    if (!this.session) throw new Error('Sign in again.');
    const freshness = classifyAccessToken(this.session, this.now());
    if (freshness === 'valid') return this.session.accessToken;
    if (freshness === 'refresh' && this.session.refreshToken && this.options.config.tenant.mode === 'pingone') {
      const next = await this.pi.refresh(this.session.refreshToken);
      this.session = {
        ...this.session,
        accessToken: next.accessToken,
        refreshToken: next.refreshToken ?? this.session.refreshToken,
        idToken: next.idToken ?? this.session.idToken,
        expiresAt: next.expiresAt,
        tokenType: next.tokenType,
      };
      await this.options.secrets.set('session', JSON.stringify(this.session));
      return this.session.accessToken;
    }
    this.session = null;
    await this.options.secrets.delete('session');
    throw new Error('Your sign-in expired. Sign in again.');
  }

  private async workerAccessToken(): Promise<string> {
    if (this.workerToken && classifyAccessToken(this.workerToken, this.now()) === 'valid') {
      return this.workerToken.accessToken;
    }
    const client = await this.workerClient();
    this.workerToken = await fetchClientCredentials({
      tokenEndpoint: tokenEndpoint(this.options.config),
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      fetchImpl: this.options.fetchImpl,
      now: () => this.now(),
    });
    return this.workerToken.accessToken;
  }

  private async workerClient(): Promise<{ clientId: string; clientSecret: string }> {
    const configuredId = this.options.config.tokenExchange.clientId.trim();
    const workerId = this.env('PINGONE_WORKER_CLIENT_ID') || configuredId;
    const workerSecret = (await this.options.secrets.get('workerClientSecret'))?.trim() ?? '';
    if (workerId && workerSecret) return { clientId: workerId, clientSecret: workerSecret };
    const agentSecret = (await this.options.secrets.get('agentClientSecret'))?.trim() ?? '';
    if (!this.env('PINGONE_WORKER_CLIENT_ID') && !workerSecret && configuredId && agentSecret) {
      return { clientId: configuredId, clientSecret: agentSecret };
    }
    throw new Error('Configure the worker client id and secret used for Protect.');
  }

  private async clientIp(): Promise<string | undefined> {
    const reported = this.options.config.protect.reportedIp.trim();
    if (reported) return reported;
    if (!this.options.config.protect.resolvePublicIp) return undefined;
    try {
      return await resolvePublicIp(this.options.fetchImpl);
    } catch {
      return undefined;
    }
  }

  private async markRisk(status: 'SUCCESS' | 'FAILED'): Promise<void> {
    if (this.options.config.tenant.mode !== 'pingone' || !this.risk?.evaluationId) return;
    try {
      const accessToken = await this.workerAccessToken();
      await updateRiskEvaluation({
        url: riskEvaluationsUrl(this.options.config, this.risk.evaluationId),
        accessToken,
        completionStatus: status,
        fetchImpl: this.options.fetchImpl,
      });
    } catch (error) {
      this.emit({
        type: 'error',
        conversationId: '',
        message: redactSecrets(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  private mockAgentToken(): TokenSet {
    const clientId = this.agentClientId();
    return this.mockToken(clientId, clientId);
  }

  private agentClientId(): string {
    return this.options.config.tokenExchange.clientId.trim() || 'agent';
  }

  private mockToken(userId: string, audience = 'user', scope?: string, includeAct = false): TokenSet {
    const expiresAt = this.now() + 8 * 60 * 60 * 1000;
    const tokenScope = scope ?? (audience === 'user' ? this.options.config.tenant.scopes.join(' ') : undefined);
    const claims: Record<string, unknown> = {
      sub: userId,
      aud: audience,
      scope: tokenScope,
      iat: Math.floor(this.now() / 1000),
      exp: Math.floor(expiresAt / 1000),
      jti: randomId(),
      mock: true,
    };
    if (audience === 'user') claims[this.options.config.access.groupsClaim] = this.mockGroupNames();
    if (includeAct) claims.act = { sub: this.agentClientId() };
    const accessToken = `${encodeJsonSegment({ alg: 'none', typ: 'mock' })}.${encodeJsonSegment(claims)}.mock`;
    return { accessToken, expiresAt, tokenType: 'Bearer', scope: tokenScope };
  }

  private inspectorEnabled(): boolean {
    return tokenInspectorEnabled(this.options.config, this.options.dev ?? false);
  }

  private assertInspector(): void {
    if (!this.inspectorEnabled()) throw new Error('Token inspection is turned off.');
  }

  private audienceById(id: string): EnterpriseConfig['tokenExchange']['audiences'][number] {
    const audience = this.options.config.tokenExchange.audiences.find((item) => item.id === id);
    if (!audience) throw new Error('That audience is not configured.');
    return audience;
  }

  private describeSession(): InspectedToken {
    const token = this.session?.accessToken ?? '';
    return this.describeToken('session', 'session', 'SSO subject token', null, token, this.session?.expiresAt);
  }

  private async describeAgent(): Promise<InspectedToken> {
    const cached = await this.readAgentToken();
    const error = this.exchangeErrors.get('agent');
    return this.describeToken(
      'agent',
      'agent',
      'client_credentials actor token',
      null,
      cached?.accessToken ?? '',
      cached?.expiresAt,
      cached?.scope,
      error ? redactSecrets(error) : cached ? undefined : 'The AI Agent access token has not been minted yet.',
    );
  }

  private async describeAudience(
    audience: EnterpriseConfig['tokenExchange']['audiences'][number],
  ): Promise<InspectedToken> {
    const cached = await this.cache.read(audience.audience);
    const error = this.exchangeErrors.get(audience.audience);
    return this.describeToken(
      audience.id,
      'exchanged',
      audience.audience,
      audience.audience,
      cached?.accessToken ?? '',
      cached?.expiresAt,
      cached?.scope ?? audience.scope,
      error ? redactSecrets(error) : cached ? undefined : 'This audience has not been exchanged yet.',
    );
  }

  private describeToken(
    id: string,
    kind: InspectedToken['kind'],
    label: string,
    audience: string | null,
    token: string,
    expiresAt?: number,
    scope?: string,
    error?: string,
  ): InspectedToken {
    const inspected = token ? inspectJwt(token, this.now(), { scope, expiresAt }) : null;
    return {
      id,
      kind,
      label,
      audience,
      present: Boolean(token),
      header: inspected?.header ?? {},
      aud: inspected?.aud ?? null,
      scope: inspected?.scope ?? scope ?? null,
      sub: inspected?.sub ?? null,
      act: inspected?.act ?? null,
      mayAct: inspected?.mayAct ?? null,
      exp: inspected?.exp ?? null,
      iat: inspected?.iat ?? null,
      expiresAt: inspected?.expiresAt ?? null,
      expiresInMs: inspected?.expiresInMs ?? null,
      error,
    };
  }

  private async refreshSessionToken(): Promise<void> {
    if (!this.session) throw new Error('Sign in to continue.');
    if (this.options.config.tenant.mode === 'mock') {
      const next = this.mockToken(this.session.userId);
      this.session = { ...this.session, accessToken: next.accessToken, expiresAt: next.expiresAt, tokenType: next.tokenType };
      await this.options.secrets.set('session', JSON.stringify(this.session));
      return;
    }
    if (!this.session.refreshToken) throw new Error('This session has no refresh token. Sign in again to replace it.');
    const next = await this.pi.refresh(this.session.refreshToken);
    this.session = {
      ...this.session,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken ?? this.session.refreshToken,
      idToken: next.idToken ?? this.session.idToken,
      expiresAt: next.expiresAt,
      tokenType: next.tokenType,
    };
    await this.options.secrets.set('session', JSON.stringify(this.session));
  }

  private async restoreSession(): Promise<void> {
    const raw = await this.options.secrets.get('session');
    if (!raw) return;
    const stored = JSON.parse(raw) as StoredSession;
    const freshness = classifyAccessToken(stored, this.now());
    if (freshness === 'reauth') {
      await this.options.secrets.delete('session');
      return;
    }
    if (freshness === 'refresh') {
      if (this.options.config.tenant.mode !== 'pingone' || !stored.refreshToken) {
        await this.options.secrets.delete('session');
        return;
      }
      try {
        const next = await this.pi.refresh(stored.refreshToken);
        stored.accessToken = next.accessToken;
        stored.refreshToken = next.refreshToken ?? stored.refreshToken;
        stored.expiresAt = next.expiresAt;
        await this.options.secrets.set('session', JSON.stringify(stored));
      } catch {
        await this.options.secrets.delete('session');
        return;
      }
    }
    this.session = { ...stored, groups: stored.groups ?? this.groupsForTokens(stored) };
    const riskRaw = this.options.db.getSetting('risk');
    if (riskRaw) {
      try {
        this.risk = JSON.parse(riskRaw) as RiskView;
      } catch {
        this.risk = null;
      }
    }
    await this.refreshFeatures();
    await this.exchangeAudiences();
    this.scheduleProtectPoll();
  }

  private async hydrateSecrets(): Promise<void> {
    await this.copyEnvSecret('workerClientSecret', 'PINGONE_WORKER_CLIENT_SECRET');
    await this.copyEnvSecret('agentClientSecret', 'PINGONE_AGENT_CLIENT_SECRET');
    await this.copyEnvSecret('openaiApiKey', 'OPENAI_API_KEY');
    await this.copyEnvSecret('anthropicApiKey', 'ANTHROPIC_API_KEY');
    await this.copyEnvSecret('genericApiKey', 'GENERIC_PROVIDER_API_KEY');
  }

  private introspectionNote(): string {
    return describeIntrospection(this.options.config.tenant.clientId);
  }

  private async copyEnvSecret(account: string, envName: string): Promise<void> {
    const value = this.env(envName);
    if (!value) return;
    if (await this.options.secrets.get(account)) return;
    await this.options.secrets.set(account, value);
  }

  private async maybeSecret(account: string, value: string | undefined, clear: boolean | undefined): Promise<void> {
    if (clear) {
      await this.options.secrets.delete(account);
      return;
    }
    if (value && value.trim()) await this.options.secrets.set(account, value.trim());
  }

  private async apiKey(provider: ProviderId): Promise<string | undefined> {
    if (provider === 'openai') return (await this.options.secrets.get('openaiApiKey')) ?? undefined;
    if (provider === 'anthropic') return (await this.options.secrets.get('anthropicApiKey')) ?? undefined;
    if (provider === 'generic') return (await this.options.secrets.get('genericApiKey')) ?? undefined;
    return undefined;
  }

  private seed(): void {
    if (this.options.db.getSetting('seeded') === '1') return;
    const config = this.options.config;
    const agents = config.agents.length
      ? config.agents
      : [{ id: 'default', nameFromBranding: true, provider: config.provider.default, model: 'mock-1' as const }];
    for (const agent of agents) {
      const name = agent.nameFromBranding ? this.options.branding.agentName : agent.name || 'Agent';
      this.options.db.upsertAgent({
        id: agent.id,
        name,
        provider: agent.provider,
        model: agent.model,
        nameFromBranding: Boolean(agent.nameFromBranding),
        instructions: agent.instructions ?? (agent.nameFromBranding ? this.options.branding.persona : null),
        userInstructions: null,
        skillIds: [],
      });
      if (agent.nameFromBranding && agent.instructions) this.options.db.setSetting('personaCustomized', '1');
    }
    for (const room of config.rooms) {
      this.options.db.upsertRoom({ ...room, createdAt: this.now() });
    }
    for (const server of config.mcpServers) {
      this.options.db.upsertMcpServer({
        id: server.id,
        name: server.name,
        transport: server.transport,
        description: server.description,
        command: server.command,
        args: server.args,
        url: server.url,
        headers: server.headers,
        envKeys: server.envKeys,
        timeout: server.timeout,
        audience: server.audience,
        scope: server.scope,
        enabled: server.enabled,
      });
    }
    const brandedId = config.agents.find((agent) => agent.nameFromBranding)?.id ?? config.agents[0]?.id ?? 'default';
    for (const routine of config.routines) {
      const agentId = routine.targetType === 'agent' ? routine.targetId : brandedId;
      this.options.db.upsertRoutine({ ...routine, agentId, createdAt: this.now(), lastFiredMinute: null });
    }
    this.options.db.setSetting('provider', config.provider.default);
    this.options.db.setSetting('model', defaultModelFor(config.provider.default, config.provider));
    this.options.db.setSetting('temperature', config.provider.temperature == null ? '' : String(config.provider.temperature));
    this.options.db.setSetting('openaiBaseUrl', config.provider.openaiBaseUrl);
    this.options.db.setSetting('anthropicBaseUrl', config.provider.anthropicBaseUrl);
    this.options.db.setSetting('genericBaseUrl', config.provider.genericBaseUrl);
    this.options.db.setSetting('seeded', '1');
  }

  private migrateAgentOwnership(): void {
    if (this.options.db.getSetting('agentOwnership') === '1') return;
    const agents = this.options.db.listAgents();
    const branded = agents.find((agent) => agent.nameFromBranding) ?? agents[0];
    if (branded) {
      const persona = this.options.db.getInstructions('persona');
      const user = this.options.db.getInstructions('user');
      const instructions = branded.instructions ?? persona ?? (branded.nameFromBranding ? this.options.branding.persona : null);
      const userInstructions = branded.userInstructions ?? user;
      if (persona && JSON.stringify(persona) !== JSON.stringify(this.options.branding.persona)) {
        this.options.db.setSetting('personaCustomized', '1');
      }
      if (!branded.instructions || !branded.userInstructions) {
        this.options.db.upsertAgent({ ...branded, instructions, userInstructions });
      }
      for (const routine of this.options.db.listRoutines()) {
        if (routine.agentId) continue;
        const ownsTarget = routine.targetType === 'agent' && agents.some((agent) => agent.id === routine.targetId);
        this.options.db.upsertRoutine({ ...routine, agentId: ownsTarget ? routine.targetId : branded.id });
      }
    }
    this.options.db.setSetting('agentOwnership', '1');
  }

  private syncBrandedAgents(): void {
    for (const agent of this.options.db.listAgents()) {
      if (!agent.nameFromBranding) continue;
      const name = this.options.branding.agentName;
      const customized = this.options.db.getSetting('personaCustomized') === '1';
      const instructions = customized ? (agent.instructions ?? this.options.branding.persona) : this.options.branding.persona;
      if (agent.name !== name || JSON.stringify(agent.instructions) !== JSON.stringify(instructions)) {
        this.options.db.upsertAgent({ ...agent, name, instructions });
      }
    }
  }

  private agentPage(agent: AgentRow): AgentPage {
    const editor = this.instructionState(agent);
    return {
      profile: this.profile(agent),
      enterprise: editor.enterprise,
      persona: editor.persona,
      user: editor.user,
      enterpriseLocked: true,
      routines: this.listRoutines(agent.id),
      skillIds: agent.skillIds,
      skills: this.options.db
        .listSkills()
        .filter((skill) => this.skillVisible(skill))
        .map((skill) => this.skillView(skill, agent.skillIds)),
    };
  }

  private instructionState(agent: AgentRow): InstructionEditorState {
    return {
      enterprise: this.options.config.enterpriseInstructions,
      persona: agent.instructions ?? (agent.nameFromBranding ? this.options.branding.persona : emptyFields()),
      user: agent.userInstructions ?? emptyFields(),
      enterpriseLocked: true,
      personaCustomized: this.options.db.getSetting('personaCustomized') === '1',
    };
  }

  private profile(agent: AgentRow): AgentProfile {
    return {
      id: agent.id,
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
      nameFromBranding: agent.nameFromBranding,
    };
  }

  private defaultAgent(): AgentRow {
    const agents = this.options.db.listAgents();
    const branded = agents.find((agent) => agent.nameFromBranding);
    const agent = branded ?? agents[0];
    if (!agent) throw new Error('No agent is configured.');
    return agent;
  }

  private requireSession(): void {
    if (!this.session || this.stepUpRequired) throw new Error('Sign in to continue.');
  }

  private sessionView(): SessionView | null {
    if (!this.session || this.stepUpRequired) return null;
    return {
      userId: this.session.userId,
      username: this.session.username,
      expiresAt: this.session.expiresAt,
      groups: this.session.groups ?? [],
      admin: this.isAdmin(),
    };
  }

  private serverView(server: McpServerRow): McpServerView {
    const pingone = server.id === this.options.config.authorize.mcpServerId;
    const tools = pingone && (!this.isAdmin() || !this.currentFeatures().pingoneTools) ? [] : this.hub.tools(server.id);
    const authKind = pingone ? 'worker' : server.audience.trim() ? 'exchange' : this.usesOauth(server) ? 'oauth' : 'open';
    const signedIn = this.oauthSignedIn.has(server.id);
    return {
      id: server.id,
      name: server.name,
      transport: server.transport,
      type: server.transport === 'http' ? 'streamable_http' : server.transport,
      description: server.description,
      command: server.command,
      args: server.args,
      url: server.url,
      headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
      envKeys: server.envKeys,
      timeout: server.timeout,
      audience: server.audience,
      scope: server.scope,
      enabled: server.enabled,
      status: this.hub.status(server.id),
      error: this.hub.error(server.id) ?? (server.audience ? this.exchangeErrors.get(server.audience) : undefined),
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        readOnlyHint: tool.readOnlyHint,
      })),
      authKind,
      needsSignIn: authKind === 'oauth' && server.enabled && !signedIn,
      signedIn,
      needsClient: this.needsClient.has(server.id),
      oauthSteps: this.oauthSteps.get(server.id) ?? [],
    };
  }

  private usesOauth(server: McpServerRow): boolean {
    if (server.id === this.options.config.authorize.mcpServerId) return false;
    if (server.audience.trim()) return false;
    return server.transport === 'http' || server.transport === 'sse';
  }

  private async rememberOauth(server: McpServerRow): Promise<void> {
    if (!this.usesOauth(server)) {
      this.oauthSignedIn.delete(server.id);
      return;
    }
    const raw = await this.options.secrets.get(mcpOauthTokenAccount(server.id));
    if (raw) this.oauthSignedIn.add(server.id);
    else this.oauthSignedIn.delete(server.id);
  }

  private async currentOauthAccessToken(extensionId: string): Promise<string | undefined> {
    try {
      const tokens = await refreshStoredMcpToken({
        extensionId,
        secrets: this.options.secrets,
        fetchImpl: this.options.fetchImpl,
        now: () => this.now(),
      });
      if (tokens) {
        this.oauthSignedIn.add(extensionId);
        return tokens.accessToken;
      }
      this.oauthSignedIn.delete(extensionId);
      return undefined;
    } catch {
      this.oauthSignedIn.delete(extensionId);
      return undefined;
    }
  }

  private async extensionEnv(server: McpServerRow): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const key of server.envKeys) {
      const value = await this.options.secrets.get(mcpEnvAccount(server.id, key));
      if (value !== null) env[key] = value;
    }
    return env;
  }

  private async storeExtensionEnv(
    id: string,
    entries: Array<{ name: string; value: string }>,
    previous: string[],
  ): Promise<string[]> {
    const names: string[] = [];
    for (const entry of entries) {
      const name = entry.name.trim();
      if (!name || names.includes(name)) continue;
      names.push(name);
      if (entry.value) await this.options.secrets.set(mcpEnvAccount(id, name), entry.value);
    }
    for (const old of previous) {
      if (!names.includes(old)) await this.options.secrets.delete(mcpEnvAccount(id, old));
    }
    return names;
  }
}

function extensionKind(input: McpServerInput): McpServerRow['transport'] {
  const type = input.type ?? (input.transport === 'http' ? 'streamable_http' : input.transport) ?? 'stdio';
  if (type === 'streamable_http') return 'http';
  if (type === 'sse' || type === 'stdio' || type === 'builtin') return type;
  if (input.transport === 'http' || input.transport === 'sse' || input.transport === 'builtin') return input.transport;
  return 'stdio';
}

function headerRecord(headers: Array<{ name: string; value: string }>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.trim();
    if (!name) continue;
    record[name] = header.value;
  }
  return record;
}

function policyView(policy: AuthorizePolicy): PolicyView {
  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    enabled: policy.enabled,
    updatedAt: policy.updatedAt,
    updatedBy: policy.updatedBy,
    scaffold: policy.scaffold,
  };
}

function emptyFields(): InstructionFields {
  return { persona: '', communicationStyle: '', autonomy: '', safety: '', untrustedContent: '' };
}

function parseArgs(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.includes('\n')) return trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  return trimmed.split(/\s+/);
}

function storedTemperature(stored: string | null, configured: number | undefined): number | null {
  if (stored == null) return configured ?? null;
  if (stored.trim() === '') return null;
  const value = Number(stored);
  return Number.isFinite(value) ? value : null;
}

function stringClaim(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function policyResetDetail(names: string[]): string {
  const count = names.length;
  const noun = count === 1 ? 'policy' : 'policies';
  const listed = count === 0 ? '' : ` (${names.join(', ')})`;
  return `Cleared ${count} local ${noun}${listed}, the Authorize decision cache, saved Trust Framework ids, and any scaffold still in progress. Nothing in PingOne was deleted.`;
}

function defaultProtectSchedule(delayMs: number, run: () => Promise<void>): () => void {
  const timer = setTimeout(() => {
    void run();
  }, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}
