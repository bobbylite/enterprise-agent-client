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
  status: 'pending' | 'done' | 'denied' | 'error';
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

export interface McpServerView {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command: string;
  args: string[];
  url: string;
  audience: string;
  scope: string;
  enabled: boolean;
  status: 'disconnected' | 'connected' | 'error';
  error?: string;
  tools: McpToolView[];
}

export interface McpToolView {
  name: string;
  description: string;
  readOnlyHint: boolean;
}

export interface McpServerInput {
  id?: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command: string;
  args: string;
  url: string;
  audience: string;
  scope: string;
  enabled: boolean;
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
  | { type: 'assistant-done'; conversationId: string; messageId: string }
  | { type: 'tool'; conversationId: string; messageId: string; tool: ToolInvocation }
  | { type: 'error'; conversationId: string; message: string }
  | { type: 'approval-required'; request: ApprovalRequest }
  | { type: 'routine-finished'; run: RoutineRun };

export interface InspectedToken {
  id: string;
  kind: 'session' | 'exchanged';
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
  logout(): Promise<AppState>;
  listConversations(): Promise<Conversation[]>;
  createConversation(): Promise<ChatSnapshot>;
  openConversation(id: string): Promise<ChatSnapshot>;
  sendMessage(conversationId: string, text: string, attachmentIds: string[]): Promise<void>;
  pickAttachments(): Promise<Attachment[]>;
  listAgents(): Promise<AgentProfile[]>;
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
  connectMcp(id: string): Promise<McpServerView>;
  disconnectMcp(id: string): Promise<McpServerView>;
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
  onChatEvent(listener: (event: ChatEvent) => void): () => void;
}
