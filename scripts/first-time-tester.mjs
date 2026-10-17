import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Matches package.json engines. Node 22.13 is the first version this app supports. */
export const REQUIRED_NODE = [22, 13, 0];

export function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    const left = actual[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

export function assertNodeVersion(version = process.version) {
  const required = REQUIRED_NODE.join('.');
  const parsed = parseNodeVersion(version);
  if (!parsed || !atLeast(parsed, REQUIRED_NODE)) {
    const running = String(version).trim() || 'an unknown version';
    return `Node.js ${required} or newer is required. This machine is running ${running}. Install Node.js ${required} or newer from https://nodejs.org and run First-time tester: install & launch again.`;
  }
  return null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A newly created enterprise file stays on mock unless both PingOne ids are
 * already filled in. Existing files are never passed here.
 */
export function applyMockDefault(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { config, changed: false };
  const tenant = config.tenant;
  if (!tenant || typeof tenant !== 'object' || Array.isArray(tenant)) return { config, changed: false };
  if (text(tenant.environmentId) && text(tenant.clientId)) return { config, changed: false };
  if (tenant.mode === 'mock') return { config, changed: false };
  return { config: { ...config, tenant: { ...tenant, mode: 'mock' } }, changed: true };
}

export function prepareTesterFiles(directory) {
  const envExample = join(directory, '.env.example');
  const envFile = join(directory, '.env');
  const example = join(directory, 'config', 'enterprise.example.json');
  const target = join(directory, 'config', 'enterprise.json');

  const createdEnv = !existsSync(envFile);
  if (createdEnv) {
    if (!existsSync(envExample)) throw new Error(`Missing ${envExample}. Clone the repository again.`);
    copyFileSync(envExample, envFile);
  }

  if (existsSync(target)) {
    return { createdEnv, createdEnterprise: false, tenantMode: null };
  }
  if (!existsSync(example)) throw new Error(`Missing ${example}. Clone the repository again.`);

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(example, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${example} as JSON. ${detail}`, { cause: error });
  }
  const { config, changed } = applyMockDefault(parsed);
  if (!changed) {
    copyFileSync(example, target);
  } else {
    writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  }
  const tenantMode = config && typeof config === 'object' && config.tenant ? config.tenant.mode ?? null : null;
  return { createdEnv, createdEnterprise: true, tenantMode };
}

export function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function runNpmInstall(cwd, spawnImpl = spawnSync) {
  const result = spawnImpl(npmExecutable(), ['install'], {
    cwd,
    stdio: 'inherit',
    env: process.env,
    // npm on Windows is a .cmd shim. Node will not spawn it unless the shell is used.
    shell: process.platform === 'win32',
  });
  if (result.error) {
    throw new Error(
      `npm install could not start (${result.error.message}). Install Node.js ${REQUIRED_NODE.join('.')} or newer, confirm npm is on PATH, and try again.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`npm install failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function report(result) {
  if (result.createdEnv) console.log('Created .env from .env.example.');
  else console.log('Left existing .env unchanged.');
  if (!result.createdEnterprise) {
    console.log('Left existing config/enterprise.json unchanged.');
    return;
  }
  if (result.tenantMode === 'mock') {
    console.log(
      'Created config/enterprise.json with tenant.mode mock. No PingOne environment id and client id were set, so the app runs with zero setup.',
    );
    return;
  }
  console.log(`Created config/enterprise.json. tenant.mode is ${result.tenantMode}.`);
}

function main() {
  const versionError = assertNodeVersion(process.version);
  if (versionError) {
    console.error(versionError);
    process.exit(1);
  }
  console.log(`Node.js ${process.version} meets the required ${REQUIRED_NODE.join('.')}.`);
  console.log('Running npm install. This also downloads the Electron binary when it is missing.');
  try {
    runNpmInstall(root);
    report(prepareTesterFiles(root));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  console.log('Local setup is ready. The launch configuration starts the app in dev mode next.');
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

if (invokedDirectly()) main();
