import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { electronBinaryInstalled, expectedPlatformPath } from '../scripts/ensure-electron.mjs';

describe('electron binary check', () => {
  it('expects the macOS app bundle path', () => {
    expect(expectedPlatformPath('darwin')).toBe('Electron.app/Contents/MacOS/Electron');
    expect(expectedPlatformPath('win32')).toBe('electron.exe');
    expect(expectedPlatformPath('linux')).toBe('electron');
  });

  it('treats a missing path.txt as not installed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'electron-missing-'));
    expect(electronBinaryInstalled(dir, 'darwin')).toBe(false);
  });

  it('accepts a macOS binary only when path.txt matches that platform', () => {
    const dir = mkdtempSync(join(tmpdir(), 'electron-mac-'));
    const binary = join(dir, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
    mkdirSync(join(binary, '..'), { recursive: true });
    writeFileSync(binary, '');
    writeFileSync(join(dir, 'path.txt'), 'Electron.app/Contents/MacOS/Electron');
    expect(electronBinaryInstalled(dir, 'darwin')).toBe(true);
    expect(electronBinaryInstalled(dir, 'linux')).toBe(false);
  });

  it('rejects a Linux path.txt when the current platform is macOS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'electron-linux-'));
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'electron'), '');
    writeFileSync(join(dir, 'path.txt'), 'electron');
    expect(electronBinaryInstalled(dir, 'linux')).toBe(true);
    expect(electronBinaryInstalled(dir, 'darwin')).toBe(false);
  });
});
