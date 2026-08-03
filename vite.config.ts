import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build:{ssr:true,rolldownOptions:{input:{
    server:resolve('src/web.ts'),worker:resolve('src/worker.ts'),'cv-worker':resolve('src/cv-worker.ts'),
    'run-cycle':resolve('src/cycle.ts'),'task-worker':resolve('src/task-worker.ts'),
  },output:{entryFileNames:'[name].mjs',chunkFileNames:'[name]-[hash].mjs'}}},
  plugins:[{
    name:'bundle-pdfjs-worker',
    generateBundle(){this.emitFile({type:'asset',fileName:'pdf.worker.mjs',
      source:readFileSync(new URL(import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')))});},
  }],
});
