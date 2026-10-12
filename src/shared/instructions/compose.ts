import { fillTemplate } from '../branding';
import type { Branding, InstructionFields } from '../types';

const SECTION_LABELS: { key: keyof InstructionFields; title: string }[] = [
  { key: 'persona', title: 'Persona' },
  { key: 'communicationStyle', title: 'Communication style' },
  { key: 'autonomy', title: 'Autonomy and approvals' },
  { key: 'safety', title: 'Safety' },
  { key: 'untrustedContent', title: 'Untrusted content' },
];

export function composeInstructions(input: {
  branding: Pick<Branding, 'appName' | 'agentName'>;
  enterprise: InstructionFields;
  persona: InstructionFields;
  user: InstructionFields;
  room?: string;
  risk?: string;
}): string {
  const apply = (text: string) => fillTemplate(text, input.branding);
  const parts = [
    `You are ${input.branding.agentName}, working inside ${input.branding.appName}.`,
    'Instruction layers, highest priority first: enterprise policy, agent persona, user preferences, room instructions, session risk.',
    'When two layers conflict, follow the higher-priority layer.',
    renderLayer('Enterprise policy (locked)', input.enterprise, apply),
    renderLayer('Agent persona', input.persona, apply),
    renderLayer('User preferences', input.user, apply),
  ];
  if (input.room?.trim()) {
    parts.push(`Room instructions:\n${apply(input.room.trim())}`);
  }
  if (input.risk?.trim()) parts.push(input.risk.trim());
  return parts.filter(Boolean).join('\n\n');
}

function renderLayer(title: string, fields: InstructionFields, apply: (text: string) => string): string {
  const sections = SECTION_LABELS.flatMap(({ key, title: section }) => {
    const value = fields[key]?.trim();
    if (!value) return [];
    return [`${section}: ${apply(value)}`];
  });
  if (sections.length === 0) return '';
  return `${title}\n${sections.join('\n')}`;
}
