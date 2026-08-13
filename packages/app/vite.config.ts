import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
const thirdParty = Object.keys(packageJson.dependencies);
const external = (id: string): boolean => thirdParty.some((dependency) => id === dependency || id.startsWith(`${dependency}/`));

export default {
  build: {
    target: 'node23',
    ssr: true,
    ssrEmitAssets: true,
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        server: resolve(root, 'src/web.ts'),
        cli: resolve(root, 'src/cli.ts'),
        worker: resolve(root, 'src/worker.ts'),
        'cv-worker': resolve(root, 'src/cv-worker.ts'),
        'refresh-profiles': resolve(root, 'src/profile-refresh.ts'),
      },
      external,
      output: { format: 'es', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' },
    },
  },
  plugins: [{
    name: 'jobseeker-pdfjs-worker',
    async buildStart(this: { emitFile(input: { type: 'asset'; fileName: string; source: Uint8Array }): void }) {
      const path = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs');
      this.emitFile({ type: 'asset', fileName: 'assets/pdf.worker.min.mjs', source: Uint8Array.from(await readFile(path)) });
    },
  }],
};
