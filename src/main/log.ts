import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AppLog {
  path: string;
  write(level: 'debug' | 'error', message: string): void;
}

/** Append scaffold diagnostics to the Electron log file. Failures stay visible if the file cannot be written. */
export function createAppLog(logPath: string): AppLog {
  return {
    path: logPath,
    write(level, message) {
      const line = `${new Date().toISOString()} ${level} ${message}\n`;
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        appendFileSync(logPath, line);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
      if (level === 'error') console.error(message);
    },
  };
}
