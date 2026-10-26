const DARWIN_PATH = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

/**
 * Finder-launched macOS apps inherit a minimal PATH, so stdio extensions
 * cannot see Homebrew or pipx shims. Prepend the usual locations on darwin
 * and leave every other platform untouched.
 */
export function commandPath(platform: string, currentPath: string | undefined, home: string | undefined): string {
  const current = currentPath ?? '';
  if (platform !== 'darwin') return current;
  const prefix = [...DARWIN_PATH];
  if (home) prefix.push(`${home.replace(/\/$/, '')}/.local/bin`);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...prefix, ...current.split(':').filter(Boolean)]) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged.join(':');
}

export function extensionProcessEnv(input: {
  platform: string;
  home?: string;
  inherited: Record<string, string | undefined>;
  extra?: Record<string, string>;
  accessToken?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.inherited)) {
    if (typeof value === 'string') env[key] = value;
  }
  Object.assign(env, input.extra);
  const path = commandPath(input.platform, env.PATH, input.home);
  if (path) env.PATH = path;
  if (input.accessToken) env.MCP_ACCESS_TOKEN = input.accessToken;
  return env;
}
