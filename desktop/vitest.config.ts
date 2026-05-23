import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Vitest setup for the desktop electron app. Covers the agent-pane port
// from agent-viewer (Project 4) — pure-logic tests for the SDK→BackendEvent
// adapter, the ContextMeter formatting, and store/timeline reducers.
//
// Excludes node_modules and out/ so we don't accidentally run third-party
// tests bundled into dependencies.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'shared'),
    },
  },
  test: {
    include: [
      'shared/**/*.test.ts',
      'main/**/*.test.ts',
      'renderer/**/*.test.ts',
      'renderer/**/*.test.tsx',
    ],
    exclude: ['node_modules/**', 'out/**', 'out-types/**'],
    environment: 'node',
  },
});
