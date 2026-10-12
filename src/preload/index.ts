import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { Ipc } from '@shared/channels';
import type { AgentBridge, ChatEvent } from '@shared/types';

const api: AgentBridge = {
  getBranding: () => ipcRenderer.invoke(Ipc.getBranding),
  getState: () => ipcRenderer.invoke(Ipc.getState),
  submitCredentials: (username, password, signals) => ipcRenderer.invoke(Ipc.submitCredentials, username, password, signals),
  submitOtp: (otp, signals) => ipcRenderer.invoke(Ipc.submitOtp, otp, signals),
  selectDevice: (deviceId, signals) => ipcRenderer.invoke(Ipc.selectDevice, deviceId, signals),
  startSystemBrowserLogin: (signals) => ipcRenderer.invoke(Ipc.startSystemBrowserLogin, signals),
  cancelLogin: () => ipcRenderer.invoke(Ipc.cancelLogin),
  setMockScenario: (scenario) => ipcRenderer.invoke(Ipc.setMockScenario, scenario),
  logout: () => ipcRenderer.invoke(Ipc.logout),
  listConversations: () => ipcRenderer.invoke(Ipc.listConversations),
  createConversation: () => ipcRenderer.invoke(Ipc.createConversation),
  openConversation: (id) => ipcRenderer.invoke(Ipc.openConversation, id),
  sendMessage: (conversationId, text, attachmentIds) => ipcRenderer.invoke(Ipc.sendMessage, conversationId, text, attachmentIds),
  pickAttachments: () => ipcRenderer.invoke(Ipc.pickAttachments),
  listAgents: () => ipcRenderer.invoke(Ipc.listAgents),
  listRooms: () => ipcRenderer.invoke(Ipc.listRooms),
  saveRoom: (input) => ipcRenderer.invoke(Ipc.saveRoom, input),
  deleteRoom: (id) => ipcRenderer.invoke(Ipc.deleteRoom, id),
  openRoom: (id) => ipcRenderer.invoke(Ipc.openRoom, id),
  sendRoomMessage: (roomId, text) => ipcRenderer.invoke(Ipc.sendRoomMessage, roomId, text),
  getInstructions: () => ipcRenderer.invoke(Ipc.getInstructions),
  savePersona: (fields) => ipcRenderer.invoke(Ipc.savePersona, fields),
  saveUserLayer: (fields) => ipcRenderer.invoke(Ipc.saveUserLayer, fields),
  resetPersona: () => ipcRenderer.invoke(Ipc.resetPersona),
  listMcpServers: () => ipcRenderer.invoke(Ipc.listMcpServers),
  saveMcpServer: (input) => ipcRenderer.invoke(Ipc.saveMcpServer, input),
  deleteMcpServer: (id) => ipcRenderer.invoke(Ipc.deleteMcpServer, id),
  connectMcp: (id) => ipcRenderer.invoke(Ipc.connectMcp, id),
  disconnectMcp: (id) => ipcRenderer.invoke(Ipc.disconnectMcp, id),
  respondApproval: (id, choice) => ipcRenderer.invoke(Ipc.respondApproval, id, choice),
  listRoutines: () => ipcRenderer.invoke(Ipc.listRoutines),
  saveRoutine: (input) => ipcRenderer.invoke(Ipc.saveRoutine, input),
  deleteRoutine: (id) => ipcRenderer.invoke(Ipc.deleteRoutine, id),
  runRoutine: (id) => ipcRenderer.invoke(Ipc.runRoutine, id),
  listRoutineRuns: (id) => ipcRenderer.invoke(Ipc.listRoutineRuns, id),
  getSettings: () => ipcRenderer.invoke(Ipc.getSettings),
  saveSettings: (input) => ipcRenderer.invoke(Ipc.saveSettings, input),
  onChatEvent: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: ChatEvent) => listener(payload);
    ipcRenderer.on(Ipc.chatEvent, wrapped);
    return () => ipcRenderer.removeListener(Ipc.chatEvent, wrapped);
  },
};

contextBridge.exposeInMainWorld('agent', api);
