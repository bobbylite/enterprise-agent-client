import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { groupsFromClaims, isAdmin } from '../src/shared/access/groups';
import { evaluatePolicies, failClosed, featuresFromAuthorize, mergeScaffold, scaffoldPolicies } from '../src/shared/authorize/policy';
import { parseEnterpriseConfig } from '../src/shared/config';
import { skillFromUpload, zipStore } from '../src/main/skill-files';
import { parseSkillMarkdown } from '../src/shared/skills/markdown';

describe('groups and authorize', () => {
  it('defaults the admin group to Administrator', () => {
    const raw = JSON.parse(readFileSync('config/enterprise.example.json', 'utf8')) as Record<string, unknown>;
    delete raw.access;
    delete raw.authorize;
    const config = parseEnterpriseConfig(raw);
    expect(config.access.adminGroup).toBe('Administrator');
    expect(config.access.groupsClaim).toBe('groups');
    expect(config.authorize.mcpServerId).toBe('pingone');
    expect(config.authorize.decisionEndpointId).toBe('');
    expect(config.authorize.cacheMs).toBe(30_000);
  });

  it('reads a groups claim from an array or a string and matches the admin group exactly', () => {
    expect(groupsFromClaims({ groups: [' Administrator ', 'Employees'] })).toEqual(['Administrator', 'Employees']);
    expect(groupsFromClaims({ groups: 'Finance, Payroll' })).toEqual(['Finance', 'Payroll']);
    expect(groupsFromClaims({}, 'groups')).toEqual([]);
    expect(isAdmin(['Employees'], 'Administrator')).toBe(false);
    expect(isAdmin(['Administrator'], 'Administrator')).toBe(true);
    expect(isAdmin(['administrator'], 'Administrator')).toBe(false);
  });

  it('evaluates starter policies so high risk overrides the admin grant', () => {
    const policies = scaffoldPolicies('Administrator', 10, 'ada');
    const admin = evaluatePolicies(policies, { groups: ['Administrator'], riskLevel: 'LOW', riskAction: 'allow' }, 11);
    expect(admin.policyTab).toBe(true);
    expect(admin.pingoneTools).toBe(true);
    expect(admin.chat).toBe('allow');
    expect(admin.mcpWrites).toBe(true);
    const locked = evaluatePolicies(policies, { groups: ['Administrator'], riskLevel: 'HIGH', riskAction: 'allow' }, 12);
    expect(locked).toMatchObject({ policyTab: false, pingoneTools: false, mcpWrites: false, chat: 'read_only', source: 'starter' });
    const employee = evaluatePolicies(policies, { groups: ['Employees'], riskLevel: 'LOW', riskAction: 'allow' }, 13);
    expect(employee.policyTab).toBe(false);
    expect(employee.chat).toBe('allow');
  });

  it('does not duplicate a scaffold and fails closed on deny', () => {
    const incoming = scaffoldPolicies('Administrator', 10, 'ada');
    const first = mergeScaffold([], incoming);
    expect(first.created).toHaveLength(4);
    const second = mergeScaffold(first.policies, incoming);
    expect(second.created).toEqual([]);
    expect(featuresFromAuthorize({ decision: 'DENY' }, 5)).toEqual(failClosed(5));
    expect(
      featuresFromAuthorize(
        { decision: 'PERMIT', statements: [{ code: 'enterprise-agent-features', payload: '{"policyTab":true,"chat":"allow"}' }] },
        6,
      )?.policyTab,
    ).toBe(true);
    expect(featuresFromAuthorize({ decision: 'PERMIT', statements: [] }, 7)).toBeNull();
  });

  it('reads SKILL.md from a zip', () => {
    const markdown = ['---', 'name: Close', 'description: Books', 'requiredGroups: [Finance, Payroll]', '---', 'Reconcile the books.'].join('\n');
    const draft = skillFromUpload(
      'close.zip',
      zipStore([
        { path: 'SKILL.md', text: markdown },
        { path: 'notes.txt', text: 'extra' },
      ]),
    );
    expect(draft).toMatchObject({
      name: 'Close',
      description: 'Books',
      requiredGroups: ['Finance', 'Payroll'],
      instructions: 'Reconcile the books.',
      files: [{ path: 'notes.txt', text: 'extra' }],
    });
    expect(parseSkillMarkdown('No front matter').name).toBe('Uploaded skill');
  });
});
