import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Repository } from './db';
import { bindIpc } from './ipc';
import { createSecretStore } from './keychain';
import { loadBranding, loadDotEnv, loadEnterprise, resolveBrandingPath, resolveEnterprisePath } from './load-config';
import { Runtime } from './runtime';

const moduleDir = dirname(fileURLToPath(import.meta.url));

if (process.env.AGENT_DISABLE_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
  app.disableHardwareAcceleration();
}

const MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

function createWindow(title: string, background: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title,
    backgroundColor: background,
    webPreferences: {
      preload: join(moduleDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.on('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    if (url.startsWith('file:')) return;
    event.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(moduleDir, '../renderer/index.html'));
  }
  return window;
}

async function boot(): Promise<void> {
  const cwd = process.cwd();
  loadDotEnv(cwd, process.env);
  const appPath = app.getAppPath();
  const branding = loadBranding(resolveBrandingPath(cwd, appPath, process.env));
  const config = loadEnterprise(resolveEnterprisePath(cwd, appPath, process.env));
  const db = Repository.open(join(app.getPath('userData'), 'agent.sqlite'));
  const { store, encryptionAvailable } = createSecretStore(db);
  const runtime = await Runtime.create({
    config,
    branding,
    db,
    secrets: store,
    appRoot: cwd,
    attachmentsDir: join(app.getPath('userData'), 'attachments'),
    encryptionAvailable,
    env: process.env,
    version: app.getVersion(),
    openExternal: (url) => shell.openExternal(url),
    pickFiles: async () => {
      const chosen = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
      });
      if (chosen.canceled) return [];
      return chosen.filePaths.map((file) => ({
        name: basename(file),
        mime: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        bytes: new Uint8Array(readFileSync(file)),
      }));
    },
  });
  const window = createWindow(branding.appName, branding.colors.sidebar);
  bindIpc(ipcMain, runtime, window, branding);
  const timer = setInterval(() => {
    void runtime.fireDueRoutines(new Date());
  }, 15_000);
  app.on('before-quit', () => {
    clearInterval(timer);
    void runtime.dispose();
  });
}

app.whenReady().then(() => {
  void boot().catch((error: unknown) => {
    dialog.showErrorBox('Unable to start', error instanceof Error ? error.message : String(error));
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
