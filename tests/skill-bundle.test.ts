import { describe, expect, it } from 'vitest';
import {
  loadSkillBundle,
  pingoneAuthorizeSkillLayer,
  readSkillReferenceFile,
  resolveSkillBundle,
  skillReferenceDenied,
  skillReferenceToolFields,
} from '../src/main/skill-bundle';

const root = resolveSkillBundle(process.cwd());

describe('PingOne Authorize skill bundle', () => {
  it('loads SKILL.md with placeholders and keeps reference bodies out of the prompt', () => {
    expect(root).toBeTruthy();
    const bundle = loadSkillBundle(root ?? '');
    expect(bundle.skillMarkdown).toContain('<environment-id>');
    expect(bundle.skillMarkdown).toContain('<decision-endpoint-id>');
    expect(bundle.skillMarkdown).toContain('PingOne Authorize — EA Admin API Build & Debug');
    expect(bundle.skillMarkdown).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(bundle.files).toEqual(
      expect.arrayContaining([
        'references/ea-api-operational-quirks.md',
        'references/decision-endpoints.md',
        'SHARING.md',
        'PATCH-NOTES.md',
        'scripts/walk_policy_tree.py',
      ]),
    );
    const layer = pingoneAuthorizeSkillLayer(bundle);
    expect(layer).toContain('Before any PingOne MCP tool call');
    expect(layer).toContain('read_skill_reference');
    expect(layer).toContain('references/ea-api-operational-quirks.md');
    expect(layer).toContain('Rate limits, Basic auth, POST-with-parent, and other operational traps.');
    expect(layer).toContain('Prints policy-tree ids, names, and depth.');
    expect(layer).not.toContain('Rate limiting is silent');
    const fields = skillReferenceToolFields(bundle.files);
    expect(fields.strict).toBe(true);
    expect(fields.description).toContain('references/ea-api-operational-quirks.md — Rate limits, Basic auth');
    const schema = fields.inputSchema as {
      required?: string[];
      additionalProperties?: boolean;
      properties?: { name?: { enum?: string[] } };
    };
    expect(schema.required).toEqual(['name']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.name?.enum).toEqual(expect.arrayContaining(bundle.files));
    const empty = skillReferenceToolFields([]);
    expect(empty.strict).toBe(false);
    expect((empty.inputSchema.properties as { name: { enum?: string[] } }).name.enum).toBeUndefined();
  });

  it('returns reference text, including the python script, and rejects traversal', () => {
    expect(root).toBeTruthy();
    const directory = root ?? '';
    const quirks = readSkillReferenceFile(directory, 'references/ea-api-operational-quirks.md');
    expect(quirks).toContain('Rate limiting is silent');
    expect(quirks).toContain('Unsupported authentication method');
    const script = readSkillReferenceFile(directory, 'scripts/walk_policy_tree.py');
    expect(script.startsWith('#!/usr/bin/env python3')).toBe(true);
    expect(script).toContain('def ');
    expect(readSkillReferenceFile(directory, 'ea-api-operational-quirks')).toContain('Rate limiting is silent');
    expect(readSkillReferenceFile(directory, 'references/ea-api-operational-quirks')).toContain('Rate limiting is silent');
    expect(readSkillReferenceFile(directory, 'scripts/walk_policy_tree').startsWith('#!/usr/bin/env python3')).toBe(true);
    const missing = () => readSkillReferenceFile(directory, '');
    expect(missing).toThrow(/not found/);
    expect(missing).toThrow(/Valid names:/);
    expect(missing).toThrow(/references\/ea-api-operational-quirks\.md/);
    expect(() => readSkillReferenceFile(directory, '{}')).toThrow(/Valid names:/);
    expect(() => readSkillReferenceFile(directory, '../SKILL.md')).toThrow(/not found/);
    expect(() => readSkillReferenceFile(directory, 'references/../../SKILL.md')).toThrow(/Valid names:/);
    expect(() => readSkillReferenceFile(directory, '/etc/passwd')).toThrow(/not found/);
    expect(() => readSkillReferenceFile(directory, 'SKILL.md')).toThrow(/not found/);
  });

  it('gates the reference tool the same way as PingOne MCP tools', () => {
    const base = {
      serverId: 'skill',
      name: 'read_skill_reference',
      mcpServerId: 'pingone',
      admin: false,
      adminGroup: 'Administrator',
      pingoneTools: true,
      skillIds: ['pingone'],
    };
    expect(skillReferenceDenied(base)).toMatch(/Administrator/);
    expect(skillReferenceDenied({ ...base, admin: true, pingoneTools: false })).toMatch(/turned PingOne tools off/);
    expect(skillReferenceDenied({ ...base, admin: true, skillIds: [] })).toMatch(/does not have the PingOne skill/);
    expect(skillReferenceDenied({ ...base, admin: true })).toBeNull();
    expect(skillReferenceDenied({ ...base, serverId: 'echo', name: 'echo' })).toBeNull();
    expect(
      skillReferenceDenied({ ...base, serverId: 'pingone', name: 'createPolicy', admin: false }),
    ).toMatch(/Administrator/);
  });
});
