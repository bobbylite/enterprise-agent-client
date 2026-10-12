import type { Branding, BrandingColors, InstructionFields } from './types';

const COLOR_KEYS: (keyof BrandingColors)[] = [
  'ink',
  'paper',
  'sidebar',
  'sidebarText',
  'accent',
  'accentInk',
  'line',
  'good',
  'warn',
  'danger',
  'code',
];

const FIELD_KEYS: (keyof InstructionFields)[] = [
  'persona',
  'communicationStyle',
  'autonomy',
  'safety',
  'untrustedContent',
];

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Branding is missing ${label}.`);
  }
  return value;
}

function readFields(value: unknown, label: string): InstructionFields {
  if (!value || typeof value !== 'object') {
    throw new Error(`Branding is missing ${label}.`);
  }
  const record = value as Record<string, unknown>;
  const fields = {} as InstructionFields;
  for (const key of FIELD_KEYS) {
    fields[key] = readString(record[key], `${label}.${key}`);
  }
  return fields;
}

export function parseBranding(raw: unknown, logoDataUrl: string | null): Branding {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Branding file must be a JSON object.');
  }
  const record = raw as Record<string, unknown>;
  const appName = readString(record.appName, 'appName');
  const agentName = readString(record.agentName, 'agentName');
  const tagline = readString(record.tagline, 'tagline');
  const about = readString(record.about, 'about');
  const colorsRaw = record.colors;
  if (!colorsRaw || typeof colorsRaw !== 'object') {
    throw new Error('Branding is missing colors.');
  }
  const colorRecord = colorsRaw as Record<string, unknown>;
  const colors = {} as BrandingColors;
  for (const key of COLOR_KEYS) {
    colors[key] = readString(colorRecord[key], `colors.${key}`);
  }
  return {
    appName,
    agentName,
    tagline,
    about,
    logoDataUrl,
    colors,
    persona: readFields(record.persona, 'persona'),
  };
}

export function fillTemplate(text: string, branding: Pick<Branding, 'appName' | 'agentName'>): string {
  return text.replaceAll('{{appName}}', branding.appName).replaceAll('{{agentName}}', branding.agentName);
}

export function emptyInstructions(): InstructionFields {
  return {
    persona: '',
    communicationStyle: '',
    autonomy: '',
    safety: '',
    untrustedContent: '',
  };
}

export function logoFileName(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const logo = (raw as { logo?: unknown }).logo;
  return typeof logo === 'string' && logo.trim() !== '' ? logo : null;
}
