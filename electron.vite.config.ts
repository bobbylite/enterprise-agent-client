import { cpSync } from 'node:fs';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const alias = {
  '@shared': resolve('src/shared'),
};

function copyPingOneAuthorizeSkill() {
  return {
    name: 'copy-pingone-authorize-skill',
    apply: 'build' as const,
    closeBundle() {
      cpSync(
        resolve('resources/skills/pingone-authorize-ea-api-build'),
        resolve('out/resources/skills/pingone-authorize-ea-api-build'),
        { recursive: true },
      );
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyPingOneAuthorizeSkill()],
    resolve: { alias },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          // Sandboxed preload cannot parse ESM. .cjs stays CommonJS when package.json type is module.
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  renderer: {
    resolve: { alias },
    plugins: [react()],
  },
});
