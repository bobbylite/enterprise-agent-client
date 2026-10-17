import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnterpriseConfig } from '../src/shared/config';
import {
  applyMockDefault,
  assertNodeVersion,
  prepareTesterFiles,
  REQUIRED_NODE,
  runNpmInstall,
} from '../scripts/first-time-tester.mjs';

const repoRoot = join(import.meta.dirname, '..');

function fencedJson(markdown: string, heading: string): unknown {
  const start = markdown.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const fence = markdown.indexOf('```json\n', start);
  const end = markdown.indexOf('\n```', fence + 8);
  return JSON.parse(markdown.slice(fence + '```json\n'.length, end));
}

describe('first-time tester setup', () => {
  it('rejects Node older than 22.13 and accepts the current engines range', () => {
    const tooOld = assertNodeVersion('v22.12.9');
    expect(tooOld).toContain('22.13.0');
    expect(tooOld).toContain('v22.12.9');
    expect(assertNodeVersion('v18.20.0')).toContain('Node.js 22.13.0 or newer is required');
    expect(assertNodeVersion('not-node')).toContain('not-node');
    expect(assertNodeVersion('v22.13.0')).toBeNull();
    expect(assertNodeVersion(`v${REQUIRED_NODE.join('.')}`)).toBeNull();
    expect(assertNodeVersion('v24.1.0')).toBeNull();
  });

  it('forces mock mode only when the new file has no PingOne ids', () => {
    const pingone = {
      tenant: { mode: 'pingone', environmentId: 'env-1', clientId: 'client-1' },
    };
    expect(applyMockDefault(pingone)).toEqual({ config: pingone, changed: false });
    const empty = { tenant: { mode: 'pingone', environmentId: '  ', clientId: '' } };
    const applied = applyMockDefault(empty);
    expect(applied.changed).toBe(true);
    expect((applied.config as { tenant: { mode: string } }).tenant.mode).toBe('mock');
    expect(applyMockDefault({ tenant: { mode: 'mock', environmentId: '', clientId: '' } }).changed).toBe(false);
  });

  it('copies local files once and never overwrites them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tester-launch-'));
    mkdirSync(join(directory, 'config'));
    const example = readFileSync(join(repoRoot, 'config', 'enterprise.example.json'));
    const envExample = readFileSync(join(repoRoot, '.env.example'));
    writeFileSync(join(directory, 'config', 'enterprise.example.json'), example);
    writeFileSync(join(directory, '.env.example'), envExample);

    const created = prepareTesterFiles(directory);
    expect(created).toEqual({ createdEnv: true, createdEnterprise: true, tenantMode: 'mock' });
    expect(readFileSync(join(directory, 'config', 'enterprise.json'))).toEqual(example);
    expect(readFileSync(join(directory, '.env'))).toEqual(envExample);
    expect(JSON.parse(readFileSync(join(directory, 'config', 'enterprise.json'), 'utf8')).tenant.mode).toBe('mock');

    writeFileSync(join(directory, '.env'), 'KEEP=yes\n');
    writeFileSync(join(directory, 'config', 'enterprise.json'), '{"keep":true}\n');
    writeFileSync(join(directory, 'config', 'enterprise.example.json'), '{"tenant":{"mode":"pingone"}}\n');
    writeFileSync(join(directory, '.env.example'), 'LOST=1\n');

    const again = prepareTesterFiles(directory);
    expect(again).toEqual({ createdEnv: false, createdEnterprise: false, tenantMode: null });
    expect(readFileSync(join(directory, '.env'), 'utf8')).toBe('KEEP=yes\n');
    expect(readFileSync(join(directory, 'config', 'enterprise.json'), 'utf8')).toBe('{"keep":true}\n');
  });

  it('writes mock mode when the example is pingone but has no tenant ids', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tester-mock-'));
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, '.env.example'), 'OPENAI_API_KEY=\n');
    writeFileSync(
      join(directory, 'config', 'enterprise.example.json'),
      JSON.stringify({ tenant: { mode: 'pingone', environmentId: '', clientId: '' } }),
    );
    const created = prepareTesterFiles(directory);
    expect(created.tenantMode).toBe('mock');
    expect(JSON.parse(readFileSync(join(directory, 'config', 'enterprise.json'), 'utf8')).tenant.mode).toBe('mock');
  });

  it('keeps pingone mode when the example already has an environment id and client id', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tester-pingone-'));
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, '.env.example'), '\n');
    const example = { tenant: { mode: 'pingone', environmentId: 'env-1', clientId: 'app-1' } };
    writeFileSync(join(directory, 'config', 'enterprise.example.json'), JSON.stringify(example));
    expect(prepareTesterFiles(directory).tenantMode).toBe('pingone');
    expect(JSON.parse(readFileSync(join(directory, 'config', 'enterprise.json'), 'utf8'))).toEqual(example);
  });

  it('surfaces a failed npm install without hiding the exit code', () => {
    expect(() =>
      runNpmInstall('/tmp', () => ({ status: 2 })),
    ).toThrow('npm install failed with exit code 2');
    expect(() =>
      runNpmInstall('/tmp', () => ({ status: null, error: new Error('spawn ENOENT') })),
    ).toThrow(/could not start/);
  });

  it('ships the VS Code launch names and a Run tests task', () => {
    const launch = JSON.parse(readFileSync(join(repoRoot, '.vscode', 'launch.json'), 'utf8')) as {
      configurations: { name: string; preLaunchTask?: string }[];
      compounds: { name: string; configurations: string[] }[];
    };
    const tasks = JSON.parse(readFileSync(join(repoRoot, '.vscode', 'tasks.json'), 'utf8')) as {
      tasks: { label: string; command?: string; args?: string[]; script?: string }[];
    };
    const names = launch.configurations.map((item) => item.name);
    expect(names).toContain('First-time tester: install & launch');
    expect(names).toContain('Debug main process');
    expect(launch.compounds.map((item) => item.name)).toContain('Dev');
    const dev = launch.compounds.find((item) => item.name === 'Dev');
    expect(dev?.configurations).toEqual(['Dev: electron', 'Dev: renderer']);
    const tester = launch.configurations.find((item) => item.name === 'First-time tester: install & launch');
    expect(tester?.preLaunchTask).toBe('First-time tester: install');
    const install = tasks.tasks.find((item) => item.label === 'First-time tester: install');
    expect(install?.command).toBe('node');
    expect(install?.args).toEqual(['scripts/first-time-tester.mjs']);
    expect(tasks.tasks.find((item) => item.label === 'Run tests')?.script).toBe('test');
  });
});

describe('quickstart examples', () => {
  it('parses the minimal and full enterprise examples', () => {
    const markdown = readFileSync(join(repoRoot, 'QUICKSTART.md'), 'utf8');
    const minimal = fencedJson(markdown, '### Minimal example');
    const full = fencedJson(markdown, '### Full example');
    expect(parseEnterpriseConfig(minimal).tenant.mode).toBe('mock');
    expect(parseEnterpriseConfig(full)).toEqual(parseEnterpriseConfig(JSON.parse(readFileSync(join(repoRoot, 'config', 'enterprise.example.json'), 'utf8'))));
    expect(markdown).toContain('chat only, tools disabled');
    expect(markdown).toContain('user-introspect-client-id');
    expect(markdown).toContain('Never commit');
    expect(markdown).not.toMatch(/sk-[A-Za-z0-9]{12,}/);
  });
});
