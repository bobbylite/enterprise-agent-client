import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const alias = {
  '@shared': resolve('src/shared'),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
