import { flue } from '@flue/vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    flue(),
    {
      name: 'job-worker-entry',
      config(_config, environment) {
        if (environment.command !== 'build') return;
        return { build: { rolldownOptions: { input: {
          worker: resolve('src/worker.ts'),
          'cv-worker': resolve('src/cv-worker.ts'),
          'run-cycle': resolve('src/scripts/run-cycle.ts'),
        } } } };
      },
    },
    {
      name: 'bundle-pdfjs-worker',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'pdf.worker.mjs',
          source: readFileSync(new URL(import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'))),
        });
      },
    },
  ],
});
