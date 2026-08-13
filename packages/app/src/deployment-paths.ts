import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function moduleDirectory(moduleUrl: string): string { return dirname(fileURLToPath(moduleUrl)); }

/** Vite may place shared modules in dist/chunks; entries still live at the dist root. */
export function bundledEntryPath(moduleUrl: string, entryFilename: string): string {
  const directory = moduleDirectory(moduleUrl);
  return resolve(basename(directory) === 'chunks' ? dirname(directory) : directory, entryFilename);
}

/** Package assets are siblings of dist (or src while running the checkout). */
export function packageRootPath(moduleUrl: string): string {
  const directory = moduleDirectory(moduleUrl);
  return basename(directory) === 'chunks' ? dirname(dirname(directory)) : dirname(directory);
}

export function packageAssetPath(moduleUrl: string, asset: string): string {
  return resolve(packageRootPath(moduleUrl), asset);
}
