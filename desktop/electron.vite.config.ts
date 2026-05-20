import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'main/index.ts'),
      },
      outDir: 'out/main',
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared'),
      },
    },
  },
  preload: {
    // Sandboxed preloads in Electron must be CommonJS — ESM preloads silently
    // fail to load under sandbox: true. Force CJS output regardless of the
    // root package.json's "type": "module".
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
      outDir: 'out/preload',
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'renderer'),
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'renderer/index.html'),
      },
      outDir: resolve(__dirname, 'out/renderer'),
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared'),
      },
    },
  },
});
