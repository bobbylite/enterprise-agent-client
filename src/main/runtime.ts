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
import { waitForLoopbackCode } from '@shared/auth/loopback';
import { classifyAccessToken, type TokenSet } from '@shared/auth/tokens';
import { groupsFromClaims, isAdmin } from '@shared/access/groups';
import {
  decisionCacheKey,
  evaluatePolicies,
  failClosed,
  featuresFromAuthorize,
  mergeScaffold,
  parseScaffoldMarker,
  scaffoldPolicies,
  SCAFFOLD_MARKER,
  type AuthorizePolicy,
  type DecisionInput,
} from '@shared/authorize/policy';
import { createRemotePolicy, listRemotePolicies, postDecision, setRemotePolicyEnabled } from '@shared/authorize/remote';
import { decodeJwtPayload, encodeJsonSegment, randomId } from '@shared/ids';
import { PINGONE_SKILL_ID, pingoneSkillInstructions, type SkillDraft } from '@shared/skills/markdown';
import { toolKey } from '@shared/mcp/approvals';
import { buildRiskEvent, createRiskEvaluation, resolvePublicIp, updateRiskEvaluation } from '@shared/protect/evaluate';
import { mockRiskPayload } from '@shared/protect/mock';
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
  McpServerInput,
  McpServerView,
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
  mockDelayMs?: number;
  version?: string;
  dev?: boolean;
  checkpointPath?: string;
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
  private readonly approvals = new Map<string, (choice: ApprovalChoice) => void>();
  private readonly pi: PiFlowClient;
  private readonly cache: AudienceTokenCache;
  private readonly hub: McpHub;
  private readonly checkpointer: NodeSqliteSaver;
  private readonly agentGraph: AgentGraph;
  private firing = false;
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
    this.hub = new McpHub({ name: options.branding.appName, version: options.version ?? '0.1.0' });
    this.checkpointer = openCheckpointer(options.checkpointPath ?? join(options.attachmentsDir, 'langgraph.sqlite'));
    this.agentGraph = compileAgentGraph(this.checkpointer);
  }

  static async create(options: RuntimeOptions): Promise<Runtime> {
    const runtime = new Runtime(options);
    await runtime.init();
    return runtime;
  }

  async dispose(): Promise<void> {
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
    this.requireSession();
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
    this.requireSession();
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
    this.requireSession();
    if (!this.options.pickFiles) throw new Error('File picking is not available.');
    const files = await this.options.pickFiles();
    const file = files[0];
    if (!file) throw new Error('Choose a SKILL.md file or a zip that contains one.');
    return this.storeSkillDraft(skillFromUpload(file.name, file.bytes));
  }

  setSkillEnabled(id: string, enabled: boolean): SkillView[] {
    this.requireSession();
    const skill = this.options.db.getSkill(id);
    if (!skill || !this.skillVisible(skill)) throw new Error('That skill was not found.');
    if (skill.requiresAdmin) this.requireAdmin();
    this.options.db.upsertSkill({ ...skill, enabled });
    return this.listSkills();
  }

  deleteSkill(id: string): SkillView[] {
    this.requireSession();
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
    this.requireSession();
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
    if (this.options.config.tenant.mode === 'pingone') await this.pullRemotePolicies();
    await this.refreshFeatures();
    return this.listPolicies();
  }

  async scaffoldPolicies(confirm: boolean): Promise<PolicyScaffoldResult> {
    this.requirePolicy();
    const incoming = scaffoldPolicies(this.options.config.access.adminGroup, this.now(), this.session?.username ?? '');
    const existing = this.options.db.listPolicies();
    const merged = mergeScaffold(existing, incoming);
    const preview = incoming.map(policyView);
    if (!confirm) return { preview, created: [], policies: existing.map(policyView) };
    for (const policy of merged.created) this.options.db.upsertPolicy(policy);
    if (this.options.config.tenant.mode === 'pingone') {
      const pending = this.options.db.listPolicies().filter((policy) => policy.scaffold && !policy.remoteId);
      await this.pushScaffold(pending);
    }
    if (merged.created.length > 0) {
      this.audit(null, 'policy:scaffold', merged.created.map((policy) => policy.name).join(', '));
    }
    this.decisionCache = null;
    await this.refreshFeatures();
    return { preview, created: merged.created.map(policyView), policies: this.options.db.listPolicies().map(policyView) };
  }

  async setPolicyEnabled(id: string, enabled: boolean): Promise<PolicyView[]> {
    this.requirePolicy();
    const policy = this.options.db.listPolicies().find((item) => item.id === id);
    if (!policy) throw new Error('That policy was not found.');
    const next = { ...policy, enabled, updatedAt: this.now(), updatedBy: this.session?.username ?? null };
    if (this.options.config.tenant.mode === 'pingone' && next.remoteId) {
      const token = await this.workerAccessToken();
      await setRemotePolicyEnabled(this.options.config, token, next.remoteId, enabled, this.options.fetchImpl ?? fetch);
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
    this.requireSession();
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
    this.requireSession();
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
    this.requireSession();
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
    const agent = this.defaultAgent();
    this.options.db.upsertAgent({ ...agent, instructions: fields });
    this.options.db.setSetting('personaCustomized', '1');
    return this.getInstructions();
  }

  saveUserLayer(fields: InstructionFields): InstructionEditorState {
    const agent = this.defaultAgent();
    this.options.db.upsertAgent({ ...agent, userInstructions: fields });
    return this.getInstructions();
  }

  resetPersona(): InstructionEditorState {
    const agent = this.defaultAgent();
    this.options.db.upsertAgent({ ...agent, instructions: this.options.branding.persona });
    this.options.db.setSetting('personaCustomized', '0');
    return this.getInstructions();
  }

  listMcpServers(): McpServerView[] {
    return this.options.db.listMcpServers().map((server) => this.serverView(server));
  }

  async saveMcpServer(input: McpServerInput): Promise<McpServerView> {
    if (!input.name.trim()) throw new Error('Give the server a name.');
    const row: McpServerRow = {
      id: input.id || randomId(),
      name: input.name.trim(),
      transport: input.transport,
      command: input.command.trim(),
      args: parseArgs(input.args),
      url: input.url.trim(),
      audience: input.audience.trim(),
      scope: input.scope.trim(),
      enabled: input.enabled,
    };
    if (row.transport === 'stdio' && !row.command) throw new Error('A stdio server needs a command.');
    if (row.transport !== 'stdio' && !row.url) throw new Error('An HTTP server needs a URL.');
    this.options.db.upsertMcpServer(row);
    return this.serverView(row);
  }

  async deleteMcpServer(id: string): Promise<void> {
    await this.hub.disconnect(id);
    this.options.db.deleteMcpServer(id);
  }

  async connectMcp(id: string): Promise<McpServerView> {
    this.requireSession();
    const server = this.options.db.listMcpServers().find((item) => item.id === id);
    if (!server) throw new Error('That server was not found.');
    const accessToken = await this.accessTokenForServer(server);
    await this.hub.connect({
      id: server.id,
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      cwd: this.options.appRoot,
      accessToken,
    });
    return this.serverView(server);
  }

  async disconnectMcp(id: string): Promise<McpServerView> {
    await this.hub.disconnect(id);
    const server = this.options.db.listMcpServers().find((item) => item.id === id);
    if (!server) throw new Error('That server was not found.');
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
    this.options.db.deleteRoutine(id);
  }

  async runRoutine(id: string): Promise<RoutineRun> {
    this.requireSession();
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
          callTool: (tool, args, accessToken) => this.hub.call(tool.serverId, tool.name, args, accessToken),
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
          availableTools: this.hub.allTools(),
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
    for (const tool of this.hub.allTools()) {
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
    if (!server.audience) return undefined;
    return this.tokenForAudience(server.audience, server.scope);
  }

  private gateTool(tool: RuntimeTool, participant: GraphParticipant | undefined): string | null {
    const features = this.currentFeatures();
    if (tool.serverId === this.options.config.authorize.mcpServerId) {
      if (!this.isAdmin()) return `PingOne tools are limited to the ${this.options.config.access.adminGroup} group.`;
      if (!features.pingoneTools) return 'Authorize turned PingOne tools off for this session.';
      if (!participant?.skillIds.includes(PINGONE_SKILL_ID)) return 'This agent does not have the PingOne skill.';
      return null;
    }
    if ((!features.mcpWrites || features.chat === 'read_only') && !tool.readOnlyHint) {
      return 'Authorize policy disabled MCP writes for this session.';
    }
    return null;
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

  private policiesForDecision(): AuthorizePolicy[] {
    const stored = this.options.db.listPolicies();
    if (stored.length > 0) return stored;
    return scaffoldPolicies(this.options.config.access.adminGroup, this.now(), 'starter');
  }

  private requireWritableChat(): void {
    if (this.currentFeatures().chat === 'read_only') {
      throw new Error('Authorize policy made this session read-only.');
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
        const files = skill.files.map((file) => `\n\nFile ${file.path}:\n${file.text}`).join('');
        return `Skill: ${skill.name}\n${skill.description}\n${skill.instructions}${files}`;
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
    const remote = await listRemotePolicies(this.options.config, token, this.options.fetchImpl ?? fetch);
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

  private async pushScaffold(created: AuthorizePolicy[]): Promise<void> {
    if (created.length === 0) return;
    const token = await this.workerAccessToken();
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const remote = await listRemotePolicies(this.options.config, token, fetchImpl);
    for (const policy of created) {
      const existing = remote.find((item) => item.name === policy.name || item.description.includes(policy.id));
      const remoteId = existing ? existing.id : await createRemotePolicy(this.options.config, token, policy, fetchImpl);
      this.options.db.upsertPolicy({ ...policy, remoteId });
    }
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
    const local = evaluatePolicies(this.policiesForDecision(), input, this.now());
    const endpoint = this.options.config.authorize.decisionEndpointId.trim();
    if (this.options.config.tenant.mode !== 'pingone' || !endpoint) {
      this.features = local;
      this.decisionCache = { key, at: this.now(), decision: local };
      return;
    }
    try {
      const token = await this.workerAccessToken();
      const body = await postDecision(
        this.options.config,
        token,
        { ...input, userId: this.session.userId, username: this.session.username },
        this.options.fetchImpl ?? fetch,
      );
      const remote = featuresFromAuthorize(body, this.now());
      this.features = remote ?? local;
    } catch {
      this.features = failClosed(this.now());
    }
    this.decisionCache = { key, at: this.now(), decision: this.features };
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
  }

  private async hydrateSecrets(): Promise<void> {
    await this.copyEnvSecret('workerClientSecret', 'PINGONE_WORKER_CLIENT_SECRET');
    await this.copyEnvSecret('agentClientSecret', 'PINGONE_AGENT_CLIENT_SECRET');
    await this.copyEnvSecret('openaiApiKey', 'OPENAI_API_KEY');
    await this.copyEnvSecret('anthropicApiKey', 'ANTHROPIC_API_KEY');
    await this.copyEnvSecret('genericApiKey', 'GENERIC_PROVIDER_API_KEY');
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
        command: server.command ?? '',
        args: server.args ?? [],
        url: server.url ?? '',
        audience: server.audience ?? '',
        scope: server.scope ?? '',
        enabled: true,
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
    return {
      ...server,
      status: this.hub.status(server.id),
      error: this.hub.error(server.id) ?? this.exchangeErrors.get(server.audience),
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        readOnlyHint: tool.readOnlyHint,
      })),
    };
  }
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
