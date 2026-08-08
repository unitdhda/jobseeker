import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import { getSearchPlatform, searchPlatformIds } from '../src/vacancies/registry.ts';

/**
 * A search-profile agent sees only `template()`; it never sees the valibot schema its answer is validated against.
 * A cap the template does not state is therefore a cap the agent discovers by having a whole profile rejected —
 * which is exactly how a career profile with thirteen evidence items cost a user their refresh in production.
 *
 * The cap is probed from each platform's own schema rather than hardcoded, so a platform that tightens or relaxes
 * its limit has to say so in its template or fail here.
 */
function probeSearchCap(schema: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>, sample: unknown): number | null {
  const accepts = (count: number): boolean =>
    v.safeParse(schema, { version: 1, searches: Array.from({ length: count }, () => sample) }).success;
  if (!accepts(1)) return null; // the template's own sample is illustrative, not valid input; nothing to probe
  for (let count = 2; count <= 64; count++) if (!accepts(count)) return count - 1;
  return null;
}

test('every platform states its search cap in the template the profile agent reads', () => {
  const probed: string[] = [];
  for (const id of searchPlatformIds) {
    const platform = getSearchPlatform(id);
    const template = platform.template();
    const sample = (template.jsonShape as { searches?: unknown[] } | undefined)?.searches?.[0];
    const cap = probeSearchCap(platform.schema, sample);
    if (cap == null) continue;
    probed.push(id);
    // `capabilities` is serialized into the prompt verbatim, so declaring it there is enough to inform the agent;
    // hh and hirehi additionally repeat it as a rule, which is welcome but not required of every platform.
    const declared = (template.capabilities as { maxSearches?: unknown }).maxSearches;
    assert.equal(declared, cap,
      `${id} accepts at most ${cap} searches but declares maxSearches=${String(declared)} to the agent`);
  }
  assert.ok(probed.length >= 15, `expected most platforms to be probeable, probed ${probed.length}`);
});
