/**
 * Type bridge for in-repo extensions: type-only re-exports are erased at runtime, so extensions written here can
 * annotate their register function while still running against the built application. The loader imports every
 * module in this directory, so this file registers nothing — the default export is a deliberate no-op.
 */
export type { JobseekerExtensionApi, JobseekerExtension } from '../packages/app/src/extensions.ts';

export default function register(): void {}
