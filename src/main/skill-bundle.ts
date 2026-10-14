import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINGONE_SKILL_ID } from '@shared/skills/markdown';

export const PINGONE_AUTHORIZE_SKILL_DIR = 'pingone-authorize-ea-api-build';
export const SKILL_REFERENCE_SERVER_ID = 'skill';
export const SKILL_REFERENCE_TOOL = 'read_skill_reference';

const EXTRA_REFERENCES = ['SHARING.md', 'PATCH-NOTES.md', 'scripts/walk_policy_tree.py'] as const;

const REFERENCE_BLURBS: Record<string, string> = {
  'references/ea-api-operational-quirks.md': 'Rate limits, Basic auth, POST-with-parent, and other operational traps.',
  'references/policy-and-rule-authoring.md': 'AAM placement, PUT body shapes, and version-field rules.',
  'references/statements-and-obligations.md': 'Which obligation codes work and the payload-vs-attributes trap.',
  'references/condition-evaluation-and-nulls.md': 'Nulls, indeterminate propagation, and what actually evaluates.',
  'references/decision-endpoints.md': 'Direct decision endpoint create, tag, attach, and evaluate.',
  'references/resolvers-and-attributes.md': 'Resolver types, REQUEST attributes, and the array-index gotcha.',
  'references/gateway-specific.md': 'PingGateway and Kong sideband specifics.',
  'SHARING.md': 'How to share the bundle and which placeholders to replace.',
  'PATCH-NOTES.md': 'What changed between skill revisions.',
  'scripts/walk_policy_tree.py': 'Prints policy-tree ids, names, and depth. Text only; do not execute.',
};

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
  const files = listReferenceFiles(root);
  const resolved = resolveReferenceName(name, files);
  if (!resolved) throw new Error(unknownReferenceMessage(files));
  const full = resolve(root, ...resolved.split('/'));
  const fromRoot = relative(resolve(root), full);
  if (fromRoot.startsWith('..') || fromRoot.split(sep).includes('..') || isAbsolute(fromRoot)) {
    throw new Error(unknownReferenceMessage(files));
  }
  if (!existsSync(full) || !statSync(full).isFile()) throw new Error(unknownReferenceMessage(files));
  return readFileSync(full, 'utf8');
}

export function unknownReferenceMessage(files: readonly string[]): string {
  const list = files.length > 0 ? files.join(', ') : '(none)';
  return `That skill reference was not found. Valid names: ${list}.`;
}

export function resolveReferenceName(name: string, files: readonly string[]): string | null {
  const normalized = normalizeReferenceName(name);
  if (!normalized || isUnsafeReference(normalized)) return null;
  const exact = files.find((file) => file === normalized);
  if (exact) return exact;
  const extended = files.filter((file) => file === `${normalized}.md` || file === `${normalized}.py`);
  if (extended.length === 1) return extended[0];
  if (normalized.includes('/')) return null;
  const stem = normalized.replace(/\.(md|py)$/, '');
  const matches = files.filter((file) => {
    const base = file.split('/').at(-1) ?? file;
    return base === normalized || base.replace(/\.(md|py)$/, '') === stem;
  });
  return matches.length === 1 ? matches[0] : null;
}

export function skillReferenceInputSchema(files: readonly string[]): Record<string, unknown> {
  const name: Record<string, unknown> = {
    type: 'string',
    description: 'Exact bundled reference name.',
  };
  if (files.length > 0) name.enum = [...files];
  return {
    type: 'object',
    properties: { name },
    required: ['name'],
    additionalProperties: false,
  };
}

export function skillReferenceToolDescription(files: readonly string[]): string {
  const listed =
    files.length > 0
      ? files.map((file) => `- ${file} — ${referenceBlurb(file)}`).join('\n')
      : '- (none installed)';
  return [
    'Read one bundled PingOne Authorize skill reference before any PingOne MCP tool that lists, reads, creates, or updates Authorize resources.',
    'The name argument is required. Pass one of the exact file names below.',
    'Returns the file as text and does not run scripts.',
    'Available references:',
    listed,
  ].join('\n');
}

export function skillReferenceToolFields(files: readonly string[]): {
  description: string;
  inputSchema: Record<string, unknown>;
  strict: boolean;
} {
  return {
    description: skillReferenceToolDescription(files),
    inputSchema: skillReferenceInputSchema(files),
    strict: files.length > 0,
  };
}

function referenceBlurb(file: string): string {
  return REFERENCE_BLURBS[file] ?? 'Bundled skill reference.';
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
    ...files.map((file) => `- ${file} — ${referenceBlurb(file)}`),
  ].join('\n');
}

function normalizeReferenceName(name: string): string {
  return name.trim().replaceAll('\\', '/');
}

function isUnsafeReference(name: string): boolean {
  if (name.startsWith('/') || name.includes('\0')) return true;
  return name.split('/').some((part) => part === '..' || part === '.' || part === '');
}
