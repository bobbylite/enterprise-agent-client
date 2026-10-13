import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export function expectedPlatformPath(platform = process.platform) {
  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'win32':
      return 'electron.exe';
    case 'linux':
    case 'freebsd':
    case 'openbsd':
      return 'electron';
    default:
      return null;
  }
}

export function electronBinaryInstalled(electronDir, platform = process.platform) {
  const expected = expectedPlatformPath(platform);
  if (!expected || !electronDir) return false;
  const pathFile = join(electronDir, 'path.txt');
  if (!existsSync(pathFile)) return false;
  const recorded = readFileSync(pathFile, 'utf8').trim();
  if (recorded !== expected) return false;
  const root = process.env.ELECTRON_OVERRIDE_DIST_PATH || join(electronDir, 'dist');
  return existsSync(join(root, recorded));
}

export function electronPackageDir() {
  return dirname(require.resolve('electron/package.json'));
}

function skipDownload() {
  const value = process.env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  return value === '1' || value === 'true';
}

export function ensureElectronBinary() {
  if (skipDownload()) {
    console.warn('ELECTRON_SKIP_BINARY_DOWNLOAD is set, so the Electron binary was not checked.');
    return;
  }
  let electronDir;
  try {
    electronDir = electronPackageDir();
  } catch {
    throw new Error('The electron package is not installed. Run npm install, then npm run dev.');
  }
  if (electronBinaryInstalled(electronDir)) return;
  const installScript = join(electronDir, 'install.js');
  console.log('Electron binary is missing. Downloading it for this operating system...');
  const result = spawnSync(process.execPath, [installScript], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      'Electron failed to download. Confirm this machine can reach GitHub releases (or set ELECTRON_MIRROR), then run: node node_modules/electron/install.js',
    );
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    ensureElectronBinary();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
