export const REQUIRED_NODE: readonly [number, number, number];

export function parseNodeVersion(version: string): [number, number, number] | null;

export function assertNodeVersion(version?: string): string | null;

export function applyMockDefault(config: unknown): { config: unknown; changed: boolean };

export function prepareTesterFiles(directory: string): {
  createdEnv: boolean;
  createdEnterprise: boolean;
  tenantMode: string | null;
};

export function npmExecutable(): string;

export function runNpmInstall(
  cwd: string,
  spawnImpl?: (
    command: string,
    args: string[],
    options: { cwd: string; stdio: 'inherit'; env: NodeJS.ProcessEnv; shell: boolean },
  ) => { status: number | null; error?: Error },
): void;
