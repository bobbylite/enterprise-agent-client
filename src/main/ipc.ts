import type { BrowserWindow, IpcMain } from 'electron';
import { Ipc } from '@shared/channels';
import { redactSecrets } from '@shared/env';
import type { AgentInput, ApprovalChoice, Branding, ChatEvent, InstructionFields, MockScenario, RoomInput, RoutineInput, SettingsInput, McpServerInput } from '@shared/types';
import type { Runtime } from './runtime';

export function bindIpc(ipcMain: IpcMain, runtime: Runtime, window: BrowserWindow, branding: Branding): void {
  runtime.setEmitter((event: ChatEvent) => {
    if (!window.isDestroyed()) window.webContents.send(Ipc.chatEvent, event);
  });

  const handle = <T extends unknown[]>(channel: string, fn: (...args: T) => Promise<unknown> | unknown) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...(args as T));
      } catch (error) {
        throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)), { cause: error });
      }
    });
  };

  handle(Ipc.getBranding, () => branding);
  handle(Ipc.getState, () => runtime.state());
  handle(Ipc.submitCredentials, (username: string, password: string, signals: string) =>
    runtime.submitCredentials(username, password, signals),
  );
  handle(Ipc.submitOtp, (otp: string, signals: string) => runtime.submitOtp(otp, signals));
  handle(Ipc.selectDevice, (deviceId: string, signals: string) => runtime.selectDevice(deviceId, signals));
  handle(Ipc.startSystemBrowserLogin, (signals: string) => runtime.startSystemBrowserLogin(signals));
  handle(Ipc.cancelLogin, () => runtime.cancelLogin());
  handle(Ipc.setMockScenario, (scenario: MockScenario) => runtime.setMockScenario(scenario));
  handle(Ipc.logout, () => runtime.logout());
  handle(Ipc.listConversations, () => runtime.listConversations());
  handle(Ipc.createConversation, () => runtime.createConversation());
  handle(Ipc.openConversation, (id: string) => runtime.openConversation(id));
  handle(Ipc.sendMessage, (conversationId: string, text: string, attachmentIds: string[]) =>
    runtime.sendMessage(conversationId, text, attachmentIds ?? []),
  );
  handle(Ipc.stopGeneration, (conversationId: string) => runtime.stopGeneration(conversationId));
  handle(Ipc.deleteConversation, (id: string) => runtime.deleteConversation(id));
  handle(Ipc.deleteRoomHistory, (roomId: string) => runtime.deleteRoomHistory(roomId));
  handle(Ipc.pickAttachments, () => runtime.pickAttachments());
  handle(Ipc.listAgents, () => runtime.listAgents());
  handle(Ipc.openAgent, (id: string) => runtime.openAgent(id));
  handle(Ipc.saveAgent, (input: AgentInput) => runtime.saveAgent(input));
  handle(Ipc.deleteAgent, (id: string) => runtime.deleteAgent(id));
  handle(Ipc.listRooms, () => runtime.listRooms());
  handle(Ipc.saveRoom, (input: RoomInput) => runtime.saveRoom(input));
  handle(Ipc.deleteRoom, (id: string) => runtime.deleteRoom(id));
  handle(Ipc.openRoom, (id: string) => runtime.openRoom(id));
  handle(Ipc.sendRoomMessage, (roomId: string, text: string) => runtime.sendRoomMessage(roomId, text));
  handle(Ipc.getInstructions, () => runtime.getInstructions());
  handle(Ipc.savePersona, (fields: InstructionFields) => runtime.savePersona(fields));
  handle(Ipc.saveUserLayer, (fields: InstructionFields) => runtime.saveUserLayer(fields));
  handle(Ipc.resetPersona, () => runtime.resetPersona());
  handle(Ipc.listMcpServers, () => runtime.listMcpServers());
  handle(Ipc.saveMcpServer, (input: McpServerInput) => runtime.saveMcpServer(input));
  handle(Ipc.deleteMcpServer, (id: string) => runtime.deleteMcpServer(id));
  handle(Ipc.connectMcp, (id: string) => runtime.connectMcp(id));
  handle(Ipc.disconnectMcp, (id: string) => runtime.disconnectMcp(id));
  handle(Ipc.respondApproval, (id: string, choice: ApprovalChoice) => runtime.respondApproval(id, choice));
  handle(Ipc.listRoutines, () => runtime.listRoutines());
  handle(Ipc.saveRoutine, (input: RoutineInput) => runtime.saveRoutine(input));
  handle(Ipc.deleteRoutine, (id: string) => runtime.deleteRoutine(id));
  handle(Ipc.runRoutine, (id: string) => runtime.runRoutine(id));
  handle(Ipc.listRoutineRuns, (id: string) => runtime.listRoutineRuns(id));
  handle(Ipc.getSettings, () => runtime.getSettingsAsync());
  handle(Ipc.saveSettings, (input: SettingsInput) => runtime.saveSettings(input));
  handle(Ipc.listTokens, () => runtime.listInspectedTokens());
  handle(Ipc.revealToken, (id: string) => runtime.revealInspectedToken(id));
  handle(Ipc.reexchangeToken, (id: string) => runtime.reexchangeToken(id));
}
