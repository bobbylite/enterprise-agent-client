export function splitCommandLine(value: string): { command: string; args: string[] } {
  const trimmed = value.trim();
  if (!trimmed) return { command: '', args: [] };
  if (trimmed.includes('\n')) {
    const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
    return { command: lines[0] ?? '', args: lines.slice(1) };
  }
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const char of trimmed) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return { command: parts[0] ?? '', args: parts.slice(1) };
}

export function joinCommandLine(command: string, args: string[]): string {
  return [command, ...args].filter((part) => part.length > 0).map(quoteArg).join(' ');
}

function quoteArg(value: string): string {
  if (!/\s/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}
