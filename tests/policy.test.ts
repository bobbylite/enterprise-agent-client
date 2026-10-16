import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { groupsFromClaims, isAdmin } from '../src/shared/access/groups';
import {
  applyLiveRiskGates,
  evaluatePolicies,
  failClosed,
  featuresFromAuthorize,
  mergeScaffold,
  policiesForEvaluation,
  reconcilePolicyCache,
  scaffoldPolicies,
  sessionRestriction,
  withAdminPolicyTab,
  SCAFFOLD_MARKER,
} from '../src/shared/authorize/policy';
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

  it('evaluates an empty set as denied and uses starters only when no decision endpoint is set', () => {
    const starters = scaffoldPolicies('Administrator', 10, 'ada');
    const empty = evaluatePolicies([], { groups: ['Administrator'], riskLevel: 'LOW', riskAction: 'allow' }, 11);
    expect(empty).toMatchObject({ policyTab: false, pingoneTools: false, mcpWrites: false, chat: 'read_only', source: 'starter' });
    expect(policiesForEvaluation([], starters, '')).toEqual(starters);
    expect(policiesForEvaluation([], starters, '   ')).toEqual(starters);
    expect(policiesForEvaluation([], starters, 'decision-1')).toEqual([]);
    expect(policiesForEvaluation(starters, [], 'decision-1')).toEqual(starters);
    const local = evaluatePolicies(policiesForEvaluation([], starters, ''), { groups: ['Administrator'], riskLevel: 'LOW', riskAction: 'allow' }, 12);
    expect(local.policyTab).toBe(true);
    expect(local.chat).toBe('allow');
  });

  it('keeps the Policy tab for an admin unless risk is high or blocked', () => {
    const closed = failClosed(5);
    const low = { groups: ['Administrator'], riskLevel: 'LOW' as const, riskAction: 'allow' as const };
    const opened = withAdminPolicyTab(closed, low, true);
    expect(opened.policyTab).toBe(true);
    expect(opened.pingoneTools).toBe(false);
    expect(opened.mcpWrites).toBe(false);
    expect(opened.chat).toBe('read_only');
    expect(withAdminPolicyTab(closed, low, false).policyTab).toBe(false);
    expect(withAdminPolicyTab(closed, { ...low, riskLevel: 'HIGH' }, true).policyTab).toBe(false);
    expect(withAdminPolicyTab(closed, { ...low, riskAction: 'block' }, true).policyTab).toBe(false);
    expect(withAdminPolicyTab(closed, { ...low, riskAction: 'read_only' }, true).policyTab).toBe(true);
    expect(sessionRestriction(closed, low, 0)).toMatchObject({ reason: 'decision_failure' });
    expect(sessionRestriction(closed, { ...low, riskLevel: 'HIGH' }, 0)?.reason).toBe('risk');
    expect(sessionRestriction({ ...closed, source: 'starter' }, low, 0)?.reason).toBe('empty_policies');
    expect(sessionRestriction({ ...closed, chat: 'allow' }, low, 0)).toBeNull();
    const starter = { ...closed, source: 'starter' as const };
    expect(applyLiveRiskGates(closed, low, true, false)).toMatchObject({ policyTab: true, chat: 'read_only', tools: false, pingoneTools: false });
    expect(applyLiveRiskGates(starter, low, true, true)).toMatchObject({
      policyTab: true,
      pingoneTools: true,
      mcpWrites: true,
      tools: true,
      agentConfig: true,
      extensionConfig: true,
      chat: 'allow',
    });
    expect(applyLiveRiskGates(starter, { ...low, riskLevel: 'MEDIUM' }, true, true)).toMatchObject({
      policyTab: true,
      pingoneTools: false,
      tools: false,
      agentConfig: true,
      extensionConfig: true,
      chat: 'allow',
    });
    expect(applyLiveRiskGates(closed, { ...low, riskLevel: 'HIGH' }, true, false)).toMatchObject({
      policyTab: false,
      tools: false,
      agentConfig: false,
      extensionConfig: false,
      chat: 'locked',
    });
    expect(applyLiveRiskGates(starter, low, false, true)).toBe(starter);
    expect(sessionRestriction(applyLiveRiskGates(starter, { ...low, riskLevel: 'HIGH' }, true, true), { ...low, riskLevel: 'HIGH' }, 1)?.message).toMatch(
      /locked until the risk drops/,
    );
  });

  it('evaluates starter policies so high risk overrides the admin grant', () => {
    const policies = scaffoldPolicies('Administrator', 10, 'ada');
    const admin = evaluatePolicies(policies, { groups: ['Administrator'], riskLevel: 'LOW', riskAction: 'allow' }, 11);
    expect(admin.policyTab).toBe(true);
    expect(admin.pingoneTools).toBe(true);
    expect(admin.chat).toBe('allow');
    expect(admin.mcpWrites).toBe(true);
    const medium = evaluatePolicies(policies, { groups: ['Administrator'], riskLevel: 'MEDIUM', riskAction: 'step_up_mfa' }, 12);
    expect(medium).toMatchObject({
      policyTab: true,
      pingoneTools: false,
      mcpWrites: false,
      tools: false,
      agentConfig: true,
      extensionConfig: true,
      chat: 'allow',
    });
    const employeeMedium = evaluatePolicies(policies, { groups: ['Employees'], riskLevel: 'MEDIUM', riskAction: 'step_up_mfa' }, 13);
    expect(employeeMedium.policyTab).toBe(false);
    expect(employeeMedium.tools).toBe(false);
    expect(employeeMedium.agentConfig).toBe(true);
    expect(employeeMedium.chat).toBe('allow');
    const locked = evaluatePolicies(policies, { groups: ['Administrator'], riskLevel: 'HIGH', riskAction: 'allow' }, 14);
    expect(locked).toMatchObject({
      policyTab: false,
      pingoneTools: false,
      mcpWrites: false,
      tools: false,
      agentConfig: false,
      extensionConfig: false,
      chat: 'locked',
      source: 'starter',
    });
    const employee = evaluatePolicies(policies, { groups: ['Employees'], riskLevel: 'LOW', riskAction: 'allow' }, 15);
    expect(employee.policyTab).toBe(false);
    expect(employee.chat).toBe('allow');
    expect(employee.tools).toBe(true);
  });

  it('does not duplicate a scaffold and fails closed on deny', () => {
    const incoming = scaffoldPolicies('Administrator', 10, 'ada');
    const first = mergeScaffold([], incoming);
    expect(first.created).toHaveLength(5);
    const second = mergeScaffold(first.policies, incoming);
    expect(second.created).toEqual([]);
    expect(featuresFromAuthorize({ decision: 'DENY' }, 5)).toEqual(failClosed(5));
    expect(featuresFromAuthorize({ decision: 'INDETERMINATE' }, 5)).toEqual(failClosed(5));
    expect(featuresFromAuthorize({ decision: 'NOT_APPLICABLE' }, 5)).toEqual(failClosed(5));
    expect(
      featuresFromAuthorize(
        { decision: 'PERMIT', statements: [{ code: 'enterprise-agent-features', payload: '{"policyTab":true,"chat":"allow"}' }] },
        6,
      )?.policyTab,
    ).toBe(true);
    expect(featuresFromAuthorize({ decision: 'PERMIT', statements: [] }, 7)).toBeNull();
  });

  it('drops local scaffold rows that PingOne no longer lists and marks those starters missing', () => {
    const starters = scaffoldPolicies('Administrator', 10, 'ada');
    const listed = (policy: (typeof starters)[number], remoteId: string) => ({
      id: remoteId,
      name: policy.name,
      description: `${policy.description}\n\n${SCAFFOLD_MARKER}\n${JSON.stringify({ id: policy.id, when: policy.when, effect: policy.effect })}`,
      enabled: true,
      updatedAt: 10,
    });
    const local = starters.map((policy, index) => ({ ...policy, remoteId: `policy-${index + 1}` }));
    const gone = reconcilePolicyCache(local, [], starters);
    expect(gone.dropIds).toEqual(starters.map((policy) => policy.id));
    expect(gone.missing.map((policy) => policy.id)).toEqual(starters.map((policy) => policy.id));

    const session = starters[0];
    const admin = starters[1];
    if (!session || !admin) throw new Error('missing starters');
    const partial = reconcilePolicyCache(
      [
        ...local,
        {
          ...session,
          id: 'custom-local',
          name: 'Custom',
          scaffold: false,
          remoteId: 'custom-old',
          description: 'A policy that used to live in PingOne.',
        },
      ],
      [listed(session, 'policy-1'), listed(admin, 'policy-9')],
      starters,
    );
    expect(partial.dropIds).toEqual([
      'enterprise-agent:medium',
      'enterprise-agent:read-only',
      'enterprise-agent:high-risk',
      'custom-local',
    ]);
    expect(partial.missing.map((policy) => policy.id)).toEqual([
      'enterprise-agent:medium',
      'enterprise-agent:read-only',
      'enterprise-agent:high-risk',
    ]);
    const kept = reconcilePolicyCache(
      [{ ...session, remoteId: 'policy-1' }],
      [{ ...listed(session, 'policy-1'), name: 'Renamed in PingOne' }],
      starters,
    );
    expect(kept.dropIds).toEqual([]);
    expect(kept.missing.map((policy) => policy.id)).not.toContain(session.id);
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
