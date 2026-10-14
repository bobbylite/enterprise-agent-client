export interface InstructionFields {
  persona: string;
  communicationStyle: string;
  autonomy: string;
  safety: string;
  untrustedContent: string;
}

export interface BrandingColors {
  ink: string;
  paper: string;
  sidebar: string;
  sidebarText: string;
  accent: string;
  accentInk: string;
  line: string;
  good: string;
  warn: string;
  danger: string;
  code: string;
}

export interface Branding {
  appName: string;
  agentName: string;
  tagline: string;
  about: string;
  logoDataUrl: string | null;
  colors: BrandingColors;
  persona: InstructionFields;
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
export type RiskAction = 'allow' | 'step_up_mfa' | 'restrict_tools' | 'read_only' | 'block';
export type RiskReasonCode =
  | 'NEW_DEVICE'
  | 'ANOMALOUS_LOCATION'
  | 'IMPOSSIBLE_TRAVEL'
  | 'BOT'
  | 'ANONYMOUS_NETWORK'
  | 'IP_REPUTATION'
  | 'OTHER';

export interface RiskReason {
  code: RiskReasonCode;
  label: string;
  detail?: string;
}

export interface RiskView {
  evaluationId?: string;
  level: RiskLevel;
  action: RiskAction;
  reasons: RiskReason[];
  summary: string;
  signalsCollected: boolean;
  evaluatedAt: number;
}

export type MockScenario = 'low' | 'new_device' | 'anomalous_location' | 'impossible_travel' | 'bot';

export type LoginPhase = 'idle' | 'credentials' | 'otp' | 'device' | 'browser-wait' | 'blocked' | 'error';

export interface LoginDevice {
  id: string;
  type: string;
  label: string;
}

export interface LoginView {
  phase: LoginPhase;
  message?: string;
  status?: string;
  devices?: LoginDevice[];
  stepUp?: boolean;
}

export interface SessionView {
  userId: string;
  username: string;
  expiresAt: number;
  groups: string[];
  admin: boolean;
}

export interface FeatureDecision {
  policyTab: boolean;
  pingoneTools: boolean;
  mcpWrites: boolean;
  chat: 'allow' | 'read_only';
  source: 'starter' | 'authorize' | 'fail_closed';
  fetchedAt: number;
}

export interface SkillView {
  id: string;
  name: string;
  description: string;
  instructions: string;
  requiredGroups: string[];
  requiresAdmin: boolean;
  builtin: boolean;
  enabled: boolean;
  assigned: boolean;
}

export interface SkillInput {
  name: string;
  description: string;
  instructions: string;
  requiredGroups: string[];
}

export interface PolicyView {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
  scaffold: boolean;
}

export interface PolicyScaffoldResult {
  preview: PolicyView[];
  created: PolicyView[];
  policies: PolicyView[];
}

export interface AuditView {
  id: string;
  at: number;
  userId: string;
  username: string;
  agentId: string | null;
  action: string;
  detail: string;
}

export interface AppState {
  mode: 'mock' | 'pingone';
  session: SessionView | null;
  risk: RiskView | null;
  stepUpRequired: boolean;
  encryptionAvailable: boolean;
  loginPreferred: 'pi.flow' | 'system-browser';
  allowSystemBrowserFallback: boolean;
  mockScenario: MockScenario;
  login: LoginView;
  showReasoning: boolean;
  adminGroup: string;
  mockAdmin: boolean;
  features: FeatureDecision;
}

export type ProviderId = 'mock' | 'openai' | 'anthropic' | 'generic';

export interface Conversation {
  id: string;
  title: string;
  kind: 'direct' | 'room' | 'routine';
  agentId: string | null;
  roomId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ToolInvocation {
  id: string;
  messageId: string;
  serverId: string;
  serverName: string;
  toolName: string;
  args: unknown;
  result: string | null;
  status: 'pending' | 'calling' | 'approval' | 'running' | 'done' | 'denied' | 'error';
  approval: 'once' | 'always' | 'deny' | 'automatic' | null;
}

export interface Attachment {
  id: string;
  messageId: string | null;
  name: string;
  mime: string;
  size: number;
  previewDataUrl?: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'tool';
  authorId: string | null;
  authorName: string | null;
  content: string;
  createdAt: number;
  reasoning?: string;
  reasoningMs?: number | null;
  phase?: 'thinking' | 'answering' | 'done' | 'cancelled';
  tools: ToolInvocation[];
  attachments: Attachment[];
}

export interface ChatSnapshot {
  conversation: Conversation;
  messages: ChatMessage[];
}

export interface AgentProfile {
  id: string;
  name: string;
  provider: ProviderId;
  model: string;
  nameFromBranding: boolean;
}

export interface AgentPage {
  profile: AgentProfile;
  enterprise: InstructionFields;
  persona: InstructionFields;
  user: InstructionFields;
  enterpriseLocked: true;
  routines: Routine[];
  /** Assigned skill ids. */
  skillIds: string[];
  skills: SkillView[];
}

export interface AgentInput {
  id?: string;
  name: string;
  provider: ProviderId;
  model: string;
  persona: InstructionFields;
  user: InstructionFields;
}

export interface Room {
  id: string;
  name: string;
  instructions: string;
  agentIds: string[];
  createdAt: number;
}

export interface RoomInput {
  id?: string;
  name: string;
  instructions: string;
  agentIds: string[];
}

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  /** Agent that owns this routine. Cron tasks are edited on that agent's page. */
  agentId: string;
  targetType: 'agent' | 'room';
  targetId: string;
  cron: string;
  enabled: boolean;
  createdAt: number;
}

export interface RoutineInput {
  id?: string;
  name: string;
  prompt: string;
  agentId?: string;
  targetType: 'agent' | 'room';
  targetId: string;
  cron: string;
  enabled: boolean;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'success' | 'error';
  output: string | null;
  error: string | null;
}

export type McpExtensionType = 'stdio' | 'streamable_http' | 'sse' | 'builtin';

export type McpAuthStepKind =
  | 'unauthorized'
  | 'protected-resource'
  | 'authorization-server'
  | 'registration'
  | 'authorize'
  | 'token'
  | 'refresh'
  | 'step-up';

export interface McpAuthStep {
  kind: McpAuthStepKind;
  title: string;
  detail: string;
  ok: boolean;
}

export interface McpHeader {
  name: string;
  value: string;
}

export interface McpEnvInput {
  name: string;
  value: string;
}

export interface McpServerView {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse' | 'builtin';
  type: McpExtensionType;
  description: string;
  command: string;
  args: string[];
  url: string;
  headers: McpHeader[];
  envKeys: string[];
  timeout: number;
  audience: string;
  scope: string;
  enabled: boolean;
  status: 'disconnected' | 'connected' | 'error';
  error?: string;
  tools: McpToolView[];
  authKind: 'open' | 'oauth' | 'exchange' | 'worker';
  needsSignIn: boolean;
  signedIn: boolean;
  needsClient: boolean;
  oauthSteps: McpAuthStep[];
}

export interface McpToolView {
  name: string;
  description: string;
  readOnlyHint: boolean;
}

export interface McpServerInput {
  id?: string;
  name: string;
  transport?: 'stdio' | 'http' | 'sse' | 'builtin';
  type?: McpExtensionType;
  description?: string;
  command: string;
  args: string;
  url: string;
  headers?: McpHeader[];
  env?: McpEnvInput[];
  timeout?: number;
  /** Omit to keep a config-seeded audience. An empty string clears it. */
  audience?: string;
  scope?: string;
  enabled: boolean;
}

export interface McpSignInInput {
  clientId?: string;
  clientSecret?: string;
}

export interface InstructionEditorState {
  enterprise: InstructionFields;
  persona: InstructionFields;
  user: InstructionFields;
  enterpriseLocked: true;
  personaCustomized: boolean;
}

export interface SettingsView {
  provider: ProviderId;
  model: string;
  temperature: number | null;
  tokenInspector: boolean;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  genericBaseUrl: string;
  keys: {
    openai: boolean;
    anthropic: boolean;
    generic: boolean;
    worker: boolean;
    agent: boolean;
  };
}

export interface SettingsInput {
  provider: ProviderId;
  model: string;
  temperature: number | null;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  genericBaseUrl: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  genericApiKey?: string;
  workerClientSecret?: string;
  agentClientSecret?: string;
  clearKeys?: Array<'openai' | 'anthropic' | 'generic' | 'worker' | 'agent'>;
}

export interface ApprovalRequest {
  id: string;
  conversationId: string;
  serverId: string;
  serverName: string;
  toolName: string;
  argumentsText: string;
  readOnlyHint: boolean;
  riskAction: RiskAction;
  allowAlways: boolean;
}

export type ApprovalChoice = 'once' | 'always' | 'deny';

export type ChatEvent =
  | { type: 'assistant-start'; conversationId: string; messageId: string; authorId: string; authorName: string }
  | { type: 'assistant-delta'; conversationId: string; messageId: string; delta: string }
  | { type: 'assistant-reasoning'; conversationId: string; messageId: string; delta: string }
  | {
      type: 'assistant-phase';
      conversationId: string;
      messageId: string;
      phase: 'thinking' | 'answering' | 'done' | 'cancelled';
      elapsedMs: number;
    }
  | { type: 'assistant-done'; conversationId: string; messageId: string }
  | { type: 'tool'; conversationId: string; messageId: string; tool: ToolInvocation }
  | { type: 'error'; conversationId: string; message: string }
  | { type: 'approval-required'; request: ApprovalRequest }
  | { type: 'routine-finished'; run: RoutineRun };

export interface InspectedToken {
  id: string;
  kind: 'session' | 'agent' | 'exchanged';
  label: string;
  audience: string | null;
  present: boolean;
  header: Record<string, unknown>;
  aud: string | null;
  scope: string | null;
  sub: string | null;
  act: unknown;
  mayAct: unknown;
  exp: number | null;
  iat: number | null;
  expiresAt: number | null;
  expiresInMs: number | null;
  error?: string;
}

export interface AgentBridge {
  getBranding(): Promise<Branding>;
  getState(): Promise<AppState>;
  submitCredentials(username: string, password: string, signals: string): Promise<AppState>;
  submitOtp(otp: string, signals: string): Promise<AppState>;
  selectDevice(deviceId: string, signals: string): Promise<AppState>;
  startSystemBrowserLogin(signals: string): Promise<AppState>;
  cancelLogin(): Promise<AppState>;
  setMockScenario(scenario: MockScenario): Promise<AppState>;
  setMockAdmin(admin: boolean): Promise<AppState>;
  logout(): Promise<AppState>;
  listConversations(): Promise<Conversation[]>;
  createConversation(): Promise<ChatSnapshot>;
  openConversation(id: string): Promise<ChatSnapshot>;
  sendMessage(conversationId: string, text: string, attachmentIds: string[]): Promise<void>;
  stopGeneration(conversationId: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  deleteRoomHistory(roomId: string): Promise<void>;
  pickAttachments(): Promise<Attachment[]>;
  listAgents(): Promise<AgentProfile[]>;
  openAgent(id: string): Promise<AgentPage>;
  saveAgent(input: AgentInput): Promise<AgentPage>;
  deleteAgent(id: string): Promise<void>;
  listRooms(): Promise<Room[]>;
  saveRoom(input: RoomInput): Promise<Room>;
  deleteRoom(id: string): Promise<void>;
  openRoom(id: string): Promise<ChatSnapshot>;
  sendRoomMessage(roomId: string, text: string): Promise<void>;
  getInstructions(): Promise<InstructionEditorState>;
  savePersona(fields: InstructionFields): Promise<InstructionEditorState>;
  saveUserLayer(fields: InstructionFields): Promise<InstructionEditorState>;
  resetPersona(): Promise<InstructionEditorState>;
  listMcpServers(): Promise<McpServerView[]>;
  saveMcpServer(input: McpServerInput): Promise<McpServerView>;
  deleteMcpServer(id: string): Promise<void>;
  setMcpEnabled(id: string, enabled: boolean): Promise<McpServerView>;
  connectMcp(id: string): Promise<McpServerView>;
  disconnectMcp(id: string): Promise<McpServerView>;
  signInMcp(id: string, input?: McpSignInInput): Promise<McpServerView>;
  signOutMcp(id: string): Promise<McpServerView>;
  respondApproval(id: string, choice: ApprovalChoice): Promise<void>;
  listRoutines(): Promise<Routine[]>;
  saveRoutine(input: RoutineInput): Promise<Routine>;
  deleteRoutine(id: string): Promise<void>;
  runRoutine(id: string): Promise<RoutineRun>;
  listRoutineRuns(id: string): Promise<RoutineRun[]>;
  getSettings(): Promise<SettingsView>;
  saveSettings(input: SettingsInput): Promise<SettingsView>;
  listTokens(): Promise<InspectedToken[]>;
  revealToken(id: string): Promise<string>;
  reexchangeToken(id: string): Promise<InspectedToken>;
  listSkills(): Promise<SkillView[]>;
  importSkill(input: SkillInput): Promise<SkillView>;
  importSkillFile(): Promise<SkillView>;
  setSkillEnabled(id: string, enabled: boolean): Promise<SkillView[]>;
  deleteSkill(id: string): Promise<SkillView[]>;
  assignSkill(agentId: string, skillId: string, assigned: boolean): Promise<AgentPage>;
  listPolicies(): Promise<PolicyView[]>;
  refreshPolicies(): Promise<PolicyView[]>;
  scaffoldPolicies(confirm: boolean): Promise<PolicyScaffoldResult>;
  resetPolicyCache(): Promise<PolicyView[]>;
  setPolicyEnabled(id: string, enabled: boolean): Promise<PolicyView[]>;
  listAudit(): Promise<AuditView[]>;
  onChatEvent(listener: (event: ChatEvent) => void): () => void;
}
