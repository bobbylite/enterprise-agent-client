import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { logoFileName, parseBranding } from '@shared/branding';
import { parseEnterpriseConfig, type EnterpriseConfig } from '@shared/config';
import { parseEnv } from '@shared/env';
import type { Branding } from '@shared/types';

export function loadDotEnv(cwd: string, env: NodeJS.ProcessEnv): void {
  const path = join(cwd, '.env');
  if (!existsSync(path)) return;
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
}

export function resolveBrandingPath(cwd: string, appPath: string, env: NodeJS.ProcessEnv): string {
  if (env.BRANDING_PATH) return resolve(cwd, env.BRANDING_PATH);
  return firstExisting([
    join(cwd, 'branding', 'default.json'),
    join(appPath, 'branding', 'default.json'),
  ]);
}

export function resolveEnterprisePath(cwd: string, appPath: string, env: NodeJS.ProcessEnv): string {
  if (env.ENTERPRISE_CONFIG) return resolve(cwd, env.ENTERPRISE_CONFIG);
  const preferred = [
    join(cwd, 'config', 'enterprise.json'),
    join(appPath, 'config', 'enterprise.json'),
  ].find((path) => existsSync(path));
  if (preferred) return preferred;
  return firstExisting([
    join(cwd, 'config', 'enterprise.example.json'),
    join(appPath, 'config', 'enterprise.example.json'),
  ]);
}

export function loadBranding(filePath: string): Branding {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  const logoName = logoFileName(raw);
  let logoDataUrl: string | null = null;
  if (logoName) {
    const logoPath = isAbsolute(logoName) ? logoName : join(dirname(filePath), logoName);
    if (!existsSync(logoPath)) throw new Error(`Branding logo was not found at ${logoPath}.`);
    const svg = readFileSync(logoPath);
    const mime = logoPath.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    logoDataUrl = `data:${mime};base64,${svg.toString('base64')}`;
  }
  return parseBranding(raw, logoDataUrl);
}

export function loadEnterprise(filePath: string): EnterpriseConfig {
  return parseEnterpriseConfig(JSON.parse(readFileSync(filePath, 'utf8')) as unknown);
}

function firstExisting(paths: string[]): string {
  const found = paths.find((path) => existsSync(path));
  if (!found) throw new Error(`Missing file. Looked in ${paths.join(', ')}.`);
  return found;
}
