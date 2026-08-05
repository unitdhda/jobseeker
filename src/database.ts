/** Composition shim: importing the client shim guarantees the store is configured before any repository runs. */
import './postgres.ts';
export * from '@jobseeker/store';
