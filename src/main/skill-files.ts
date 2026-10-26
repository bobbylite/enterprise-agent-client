import { inflateRawSync } from 'node:zlib';
import { parseSkillMarkdown, type SkillDraft, type SkillFile } from '@shared/skills/markdown';

const LOCAL_FILE = 0x04034b50;

export function skillFromUpload(name: string, bytes: Uint8Array): SkillDraft {
  const lower = name.toLowerCase();
  if (lower.endsWith('.zip')) return skillFromZip(bytes);
  const text = new TextDecoder().decode(bytes);
  return parseSkillMarkdown(text);
}

export function skillFromZip(bytes: Uint8Array): SkillDraft {
  const files = unzip(bytes)
    .filter((file) => !file.path.endsWith('/'))
    .map((file) => ({ path: file.path, text: new TextDecoder().decode(file.bytes) }));
  const markdown = files.find((file) => file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md'));
  if (!markdown) throw new Error('The skill archive needs a SKILL.md file.');
  const rest = files.filter((file) => file !== markdown);
  return parseSkillMarkdown(markdown.text, rest);
}

export function zipStore(files: SkillFile[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const file of files) {
    const name = new TextEncoder().encode(file.path);
    const data = new TextEncoder().encode(file.text);
    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, LOCAL_FILE, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, 0, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);
    header.set(name, 30);
    chunks.push(header, data);
  }
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function unzip(bytes: Uint8Array): { path: string; bytes: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files: { path: string; bytes: Uint8Array }[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    if (view.getUint32(offset, true) !== LOCAL_FILE) break;
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const path = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error('The skill archive has an unsafe path.');
    const dataStart = nameStart + nameLength + extraLength;
    if (flags & 0x8) throw new Error('That zip uses a data descriptor. Export the skill again.');
    const data = bytes.subarray(dataStart, dataStart + compressed);
    if (!path.endsWith('/')) {
      if (method === 0) files.push({ path, bytes: data });
      else if (method === 8) files.push({ path, bytes: inflateRawSync(data) });
      else throw new Error(`Unsupported zip method ${method} for ${path}.`);
    }
    offset = dataStart + compressed;
  }
  if (files.length === 0) throw new Error('The skill archive is empty.');
  return files;
}
