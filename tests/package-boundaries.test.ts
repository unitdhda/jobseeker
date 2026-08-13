import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const packagesRoot = resolve(root, 'packages');

async function typescriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await typescriptFiles(path));
    else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

async function existingTypescriptFiles(directory: string): Promise<string[]> {
  try {
    return (await stat(directory)).isDirectory() ? await typescriptFiles(directory) : [];
  } catch {
    return [];
  }
}

function repositoryPath(path: string): string {
  return relative(root, path).split(sep).join('/');
}

/** Architectural linting needs module specifiers, not a full TypeScript parser; comments cannot create package edges. */
function moduleSpecifiers(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1');
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ];
  return patterns.flatMap((pattern) => [...withoutComments.matchAll(pattern)].map((match) => match[1]!));
}

function workspacePackage(specifier: string): string | null {
  const match = /^@jobseeker\/(engine|cv|sources|store|app)(?:\/|$)/u.exec(specifier);
  return match?.[1] ?? null;
}

const allowedInternalDependencies: Readonly<Record<string, ReadonlySet<string>>> = {
  engine: new Set(),
  cv: new Set(),
  sources: new Set(['engine']),
  store: new Set(['engine', 'cv']),
  app: new Set(['engine', 'cv', 'sources', 'store']),
};

test('workspace imports follow the one-way package graph', async () => {
  const violations: string[] = [];
  for (const owner of Object.keys(allowedInternalDependencies)) {
    for (const file of await existingTypescriptFiles(resolve(packagesRoot, owner, 'src'))) {
      const source = await readFile(file, 'utf8');
      for (const specifier of moduleSpecifiers(source)) {
        const dependency = workspacePackage(specifier);
        if (dependency && !allowedInternalDependencies[owner]!.has(dependency)) {
          violations.push(`${repositoryPath(file)} imports forbidden internal package ${specifier}`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('sources and store use only their approved engine subpaths', async () => {
  const violations: string[] = [];
  const allowed: Readonly<Record<string, readonly RegExp[]>> = {
    sources: [/^@jobseeker\/engine\/contracts$/u, /^@jobseeker\/engine$/u],
    store: [
      /^@jobseeker\/engine\/contracts$/u,
      /^@jobseeker\/engine\/match-state$/u,
      /^@jobseeker\/engine$/u,
    ],
  };
  for (const owner of ['sources', 'store'] as const) {
    for (const file of await existingTypescriptFiles(resolve(packagesRoot, owner, 'src'))) {
      for (const specifier of moduleSpecifiers(await readFile(file, 'utf8'))) {
        if (specifier.startsWith('@jobseeker/engine/')
          && !allowed[owner].some((pattern) => pattern.test(specifier))) {
          violations.push(`${repositoryPath(file)} imports unapproved engine surface ${specifier}`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('domain packages never read ambient environment variables', async () => {
  const violations: string[] = [];
  for (const owner of ['engine', 'cv', 'sources', 'store']) {
    for (const file of await existingTypescriptFiles(resolve(packagesRoot, owner, 'src'))) {
      const source = await readFile(file, 'utf8');
      if (/\bprocess\s*\.\s*env\b|\bBun\s*\.\s*env\b/u.test(source)) {
        violations.push(`${repositoryPath(file)} reads ambient environment state`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('application source contains no raw SQL and imports no source examples', async () => {
  const violations: string[] = [];
  const sqlStatement = /^\s*(?:select\b[\s\S]*\bfrom\b|insert\s+into\b|update\b[\s\S]*\bset\b|delete\s+from\b|create\s+table\b|alter\s+table\b|drop\s+table\b)/iu;
  for (const file of await existingTypescriptFiles(resolve(packagesRoot, 'app', 'src'))) {
    const source = await readFile(file, 'utf8');
    // SQL owned by the store appears as statement-like string/template literals, not arbitrary method names.
    const literals = [...source.matchAll(/(['"`])([\s\S]*?)\1/gu)].map((match) => match[2]!);
    if (literals.some((literal) => sqlStatement.test(literal))) {
      violations.push(`${repositoryPath(file)} contains raw SQL`);
    }
    for (const specifier of moduleSpecifiers(source)) {
      if (specifier.includes('packages/sources/examples') || specifier.startsWith('@jobseeker/sources/examples')) {
        violations.push(`${repositoryPath(file)} imports source examples through ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('copied source examples keep workspace imports type-only and runtime dependencies deployment-local', async () => {
  const violations: string[] = [];
  for (const file of await existingTypescriptFiles(resolve(packagesRoot, 'sources', 'examples'))) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/\bimport\s+(type\s+)?[^'";]*?from\s+['"]([^'"]+)['"]/gu)) {
      const typeOnly = match[1] !== undefined;
      const specifier = match[2]!;
      if (specifier.startsWith('@jobseeker/') && !typeOnly) {
        violations.push(`${repositoryPath(file)} has runtime workspace import ${specifier}`);
      }
      if (!specifier.startsWith('.') && specifier !== 'valibot' && !specifier.startsWith('@jobseeker/')) {
        violations.push(`${repositoryPath(file)} has undeclared copied-example runtime dependency ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('published sources runtime contains generic drivers rather than concrete source adapters', async () => {
  const sourceRoot = resolve(packagesRoot, 'sources', 'src');
  const allowedTopLevel = new Set([
    'boards.ts', 'companies.ts', 'context.ts', 'contract.ts', 'http.ts', 'index.ts', 'sources.ts',
  ]);
  const violations: string[] = [];
  for (const file of await existingTypescriptFiles(sourceRoot)) {
    const path = repositoryPath(file);
    const relativeSourcePath = relative(sourceRoot, file).split(sep).join('/');
    if (!relativeSourcePath.includes('/') && !allowedTopLevel.has(relativeSourcePath)) {
      violations.push(`${path} is not an approved generic sources-runtime module`);
    }
    if (relativeSourcePath.startsWith('drivers/')
      && !/^(?:drivers\/(?:api|ats|company-site|jsonld-board)\.ts|drivers\/\.gitkeep)$/u.test(relativeSourcePath)) {
      violations.push(`${path} is not an approved generic source driver`);
    }
  }
  assert.deepEqual(violations, []);
});
