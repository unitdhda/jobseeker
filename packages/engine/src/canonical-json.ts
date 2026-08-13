export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export class CanonicalJsonError extends TypeError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Invalid canonical JSON input at ${path}: ${reason}`);
    this.name = 'CanonicalJsonError';
    this.path = path;
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function plainDataEntries(value: object, path: string): [string, unknown][] {
  if (!isPlainObject(value)) {
    throw new CanonicalJsonError(path,
      `expected a plain JSON object, received ${value.constructor?.name ?? 'an object with a custom prototype'}.`);
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new CanonicalJsonError(path, 'symbol properties are not valid JSON.');
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]!;
    const propertyPath = `${path}[${JSON.stringify(key)}]`;
    if (!descriptor.enumerable) {
      throw new CanonicalJsonError(propertyPath, 'non-enumerable properties are not supported.');
    }
    if (!('value' in descriptor)) {
      throw new CanonicalJsonError(propertyPath, 'accessor properties are not supported.');
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function stringify(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(path, 'JSON numbers must be finite.');
      }
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new CanonicalJsonError(path, `${typeof value} is not a supported JSON value.`);
    case 'object':
      break;
  }

  if (ancestors.has(value)) {
    throw new CanonicalJsonError(path, 'circular references are not supported.');
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new CanonicalJsonError(`${path}[${index}]`, 'sparse arrays are not supported.');
        }
        items.push(stringify(value[index], `${path}[${index}]`, ancestors));
      }
      return `[${items.join(',')}]`;
    }

    const entries = plainDataEntries(value, path)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) =>
      `${JSON.stringify(key)}:${stringify(entry, `${path}[${JSON.stringify(key)}]`, ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Strict, deterministic JSON serialization for content identities and hashes. */
export function canonicalJsonStringify(value: unknown, rootName = 'value'): string {
  return stringify(value, rootName, new Set());
}
