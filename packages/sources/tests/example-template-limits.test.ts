import './toolkit-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import { exampleSources } from '../examples/index.ts';

/**
 * A search-profile agent sees only `template()`; it never sees the valibot schema its answer is validated against.
 * A cap the template does not state is therefore a cap the agent discovers by having a whole profile rejected —
 * which is exactly how a career profile with thirteen evidence items cost a user their refresh in production.
 *
 * The cap is probed from each provider's own schema rather than hardcoded, so a provider that tightens or relaxes
 * its limit has to say so in its template or fail here.
 */
function probeSearchCap(schema: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>, sample: unknown): number | null {
  const accepts = (count: number): boolean =>
    v.safeParse(schema, { version: 1, searches: Array.from({ length: count }, () => sample) }).success;
  if (!accepts(1)) return null; // the template's own sample is illustrative, not valid input; nothing to probe
  for (let count = 2; count <= 64; count++) if (!accepts(count)) return count - 1;
  return null;
}

test('every example states its search cap in the template the profile agent reads', () => {
  const probed: string[] = [];
  for (const provider of exampleSources({ atsBoards: ['greenhouse:example'] })) {
    const template = provider.template();
    const sample = (template.jsonShape as { searches?: unknown[] } | undefined)?.searches?.[0];
    const cap = probeSearchCap(provider.schema, sample);
    if (cap == null) continue;
    probed.push(provider.id);
    // `capabilities` is serialized into the prompt verbatim, so declaring it there is enough to inform the agent;
    // hirehi additionally repeats it as a rule, which is welcome but not required of every provider.
    const declared = (template.capabilities as { maxSearches?: unknown }).maxSearches;
    assert.equal(declared, cap,
      `${provider.id} accepts at most ${cap} searches but declares maxSearches=${String(declared)} to the agent`);
  }
  assert.ok(probed.length >= 15, `expected most examples to be probeable, probed ${probed.length}`);
});
