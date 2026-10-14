import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINGONE_SKILL_ID } from '@shared/skills/markdown';

export const PINGONE_AUTHORIZE_SKILL_DIR = 'pingone-authorize-ea-api-build';
export const SKILL_REFERENCE_SERVER_ID = 'skill';
export const SKILL_REFERENCE_TOOL = 'read_skill_reference';

const EXTRA_REFERENCES = ['SHARING.md', 'PATCH-NOTES.md', 'scripts/walk_policy_tree.py'] as const;

export interface SkillBundle {
  root: string;
  skillMarkdown: string;
  files: string[];
}

export function skillBundleCandidates(appRoot: string, moduleDir = dirname(fileURLToPath(import.meta.url))): string[] {
  return [
    join(appRoot, 'resources', 'skills', PINGONE_AUTHORIZE_SKILL_DIR),
    join(appRoot, 'out', 'resources', 'skills', PINGONE_AUTHORIZE_SKILL_DIR),
    join(moduleDir, '..', 'resources', 'skills', PINGONE_AUTHORIZE_SKILL_DIR),
    join(moduleDir, '..', '..', 'resources', 'skills', PINGONE_AUTHORIZE_SKILL_DIR),
  ];
}

export function resolveSkillBundle(appRoot: string, moduleDir?: string): string | null {
  const found = skillBundleCandidates(appRoot, moduleDir).find((path) => existsSync(join(path, 'SKILL.md')));
  return found ? resolve(found) : null;
}

export function loadSkillBundle(root: string): SkillBundle {
  return {
    root: resolve(root),
    skillMarkdown: readFileSync(join(root, 'SKILL.md'), 'utf8'),
    files: listReferenceFiles(root),
  };
}

export function pingoneAuthorizeSkillLayer(bundle: SkillBundle): string {
  return `${referenceDirective(bundle.files)}\n\n${bundle.skillMarkdown.trim()}`;
}

export function readSkillReferenceFile(root: string, name: string): string {
  const normalized = normalizeReferenceName(name);
  if (!isAllowedReference(normalized)) throw new Error('That skill reference was not found.');
  const full = resolve(root, ...normalized.split('/'));
  const fromRoot = relative(resolve(root), full);
  if (fromRoot.startsWith('..') || fromRoot.split(sep).includes('..') || isAbsolute(fromRoot)) {
    throw new Error('That skill reference was not found.');
  }
  if (!existsSync(full) || !statSync(full).isFile()) throw new Error('That skill reference was not found.');
  return readFileSync(full, 'utf8');
}

export function isSkillReferenceTool(tool: { serverId: string; name: string }): boolean {
  return tool.serverId === SKILL_REFERENCE_SERVER_ID && tool.name === SKILL_REFERENCE_TOOL;
}

export function skillReferenceDenied(input: {
  serverId: string;
  name: string;
  mcpServerId: string;
  admin: boolean;
  adminGroup: string;
  pingoneTools: boolean;
  skillIds: readonly string[];
}): string | null {
  const governed = isSkillReferenceTool(input) || input.serverId === input.mcpServerId;
  if (!governed) return null;
  if (!input.admin) return `PingOne tools are limited to the ${input.adminGroup} group.`;
  if (!input.pingoneTools) return 'Authorize turned PingOne tools off for this session.';
  if (!input.skillIds.includes(PINGONE_SKILL_ID)) return 'This agent does not have the PingOne skill.';
  return null;
}

function listReferenceFiles(root: string): string[] {
  const referencesDir = join(root, 'references');
  const references = existsSync(referencesDir)
    ? readdirSync(referencesDir)
        .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name))
        .sort()
        .map((name) => `references/${name}`)
    : [];
  const extras = EXTRA_REFERENCES.filter((name) => existsSync(join(root, name)));
  return [...references, ...extras];
}

function referenceDirective(files: string[]): string {
  return [
    'PingOne Authorize reference files are not inlined in this prompt.',
    'Before any PingOne MCP tool call that lists, reads, creates, or updates Authorize resources (authorizationPolicies, authorizationAttributes, statements, obligations, resolvers, decisionEndpoints, apiServers, or deployment), call read_skill_reference and read the matching file.',
    'Start with references/ea-api-operational-quirks.md when a call fails, a POST might include parent, or the request shape is uncertain.',
    'read_skill_reference returns file text only. Do not execute scripts/walk_policy_tree.py.',
    'Desktop scaffold policies are free-standing library policies. Do not send parent on POST /authorizationPolicies. A 201 from POST-with-parent can still place the policy under the shared Policies root. AAM Custom-node placement is a full PUT of that node when disallowChildren is false.',
    'Worker and AI Agent client-credentials tokens use HTTP Basic (client_secret_basic). Do not put client_id or client_secret in the token request body.',
    'Trust Framework REQUEST parameters use the attribute full name and a JSON value whose type matches valueType. The desktop decision client uses a separate contract: every parameter value is a string (user.id, user.name, user.groups, risk.level, risk.score, risk.action). Do not send those app keys as numbers, and do not send Trust Framework names to that desktop decision call.',
    'Available references:',
    ...files.map((file) => `- ${file}`),
  ].join('\n');
}

function normalizeReferenceName(name: string): string {
  return name.trim().replaceAll('\\', '/');
}

function isAllowedReference(name: string): boolean {
  if ((EXTRA_REFERENCES as readonly string[]).includes(name)) return true;
  return /^references\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name);
}
