export interface SkillFile {
  path: string;
  text: string;
}

export interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
  requiredGroups: string[];
  files: SkillFile[];
}

export function parseSkillMarkdown(markdown: string, files: SkillFile[] = []): SkillDraft {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = match ? match[1] ?? '' : '';
  const body = (match ? match[2] : markdown).trim();
  const name = field(meta, 'name') || 'Uploaded skill';
  const description = field(meta, 'description');
  const requiredGroups = splitList(field(meta, 'requiredGroups'));
  return { name, description, instructions: body, requiredGroups, files };
}

function field(meta: string, key: string): string {
  const line = meta.split(/\r?\n/).find((item) => item.toLowerCase().startsWith(`${key.toLowerCase()}:`));
  if (!line) return '';
  return line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '');
}

function splitList(value: string): string[] {
  if (!value) return [];
  const trimmed = value.replace(/^\[|\]$/g, '');
  return trimmed
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter((item) => item.length > 0);
}

export const PINGONE_SKILL_ID = 'pingone';

export function pingoneSkillInstructions(adminGroup: string): string {
  return [
    `You can administer PingOne for members of the ${adminGroup} group.`,
    'Use the PingOne MCP server to list, create, and update PingOne Authorize policies when the user asks for that.',
    'The desktop app attaches the PingOne worker token to those calls. Do not ask the user to paste a token.',
    'Write actions still wait for approval, and the Protect risk policy still applies.',
    'If a tool is denied because the user is not an administrator, say so and stop.',
  ].join(' ');
}
