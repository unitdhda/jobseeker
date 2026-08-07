import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Dependencies are hoisted to the workspace root, so the worker asset is resolved rather than path-joined.
const require = createRequire(import.meta.url);

export default defineConfig({
  // Workspace packages are bundled so dist/ stays a self-contained deploy artifact.
  ssr:{noExternal:[/^@jobseeker\//]},
  build:{ssr:true,rolldownOptions:{input:{
    server:resolve('src/web.ts'),worker:resolve('src/worker.ts'),'cv-worker':resolve('src/cv-worker.ts'),
    'refresh-profiles':resolve('src/profile-refresh.ts'),
  },output:{entryFileNames:'[name].mjs',chunkFileNames:'[name]-[hash].mjs'}}},
  plugins:[{
    name:'bundle-pdfjs-worker',
    generateBundle(){this.emitFile({type:'asset',fileName:'pdf.worker.mjs',
      source:readFileSync(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'))});},
  }],
});
