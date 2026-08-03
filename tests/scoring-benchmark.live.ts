/**
 * Compares candidate scoring models on jobseeker's real prompt shape and schema.
 * Measures schema validity, score stability across repeats, latency, and cost.
 *
 *   bun --no-env-file tests/scoring-benchmark.live.ts [repeats] [model,model] [effort,effort]
 */
import { contentText, createModels, type ThinkingLevel } from '@earendil-works/pi-ai';
import * as v from 'valibot';
import { claudeCliProvider } from '../src/claude-cli.ts';

const vacancyScoreSchema = v.object({
  vacancyId: v.pipe(v.number(), v.integer(), v.minValue(1)),
  score: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100)),
  primaryTrack: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  summary: v.pipe(v.string(), v.minLength(5), v.maxLength(1_000)),
  reasons: v.pipe(v.array(v.pipe(v.string(), v.minLength(2), v.maxLength(500))), v.maxLength(10)),
  gaps: v.pipe(v.array(v.pipe(v.string(), v.minLength(2), v.maxLength(500))), v.maxLength(10)),
  hardRejection: v.boolean(),
});
const scoringResultSchema = v.union([
  v.object({ scores: v.pipe(v.array(vacancyScoreSchema), v.minLength(1), v.maxLength(20)) }),
  v.pipe(v.array(vacancyScoreSchema), v.minLength(1), v.maxLength(20)),
]);

function jsonText(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch {
    const start = Math.min(...['{', '['].map((c) => { const i = trimmed.indexOf(c); return i < 0 ? Infinity : i; }));
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    if (!Number.isFinite(start) || end <= start) throw new Error('no JSON');
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

const cv = `Frontend developer, 6 years commercial experience. React, TypeScript, Next.js, Redux, Node.js/Express.
Led a design-system rebuild used by 4 product teams. Mentored 2 juniors. Some Python for internal tooling.
Russian native, English C1. Based in Moscow, open to remote and hybrid. Seeking senior frontend roles.`;

/** 4 = strong match, 5 = borderline (adjacent stack, seniority gap), 6 = hard reject (different occupation). */
const vacancies = [
  { id: 4001, name: 'Senior Frontend Developer (React)', employer: 'Fintech LLC', area: 'Moscow', salary: '300000-400000 RUB',
    description: 'React, TypeScript, design systems. 5+ years. Hybrid Moscow, 2 days office. Mentoring juniors expected.' },
  { id: 4002, name: 'Full-stack Engineer (Node + Vue)', employer: 'RetailTech', area: 'Remote', salary: 'not specified',
    description: 'Vue 3 and Node.js. 3+ years. We also use Python. Remote within Russia. Team of 5, no mentoring duties.' },
  { id: 4003, name: 'Senior Java Backend Engineer', employer: 'BankCore', area: 'Kazan', salary: '350000 RUB',
    description: 'Java 17, Spring Boot, Kafka, PostgreSQL. 7+ years backend required. Strictly on-site in Kazan.' },
];

const systemPrompt = 'You score vacancies against a CV for fit. Be calibrated and strict: 80+ means a strong match the '
  + 'candidate should apply to today, 50-79 worth reviewing, below 50 poor fit. Set hardRejection when the vacancy is a '
  + 'different occupation or has a disqualifying constraint. Return only the requested JSON value without Markdown.';
const prompt = `CV:\n${cv}\n\nVACANCIES:\n${JSON.stringify(vacancies, null, 1)}\n\n`
  + 'Return {"scores":[{"vacancyId":number,"score":0-100,"primaryTrack":string,"summary":string,"reasons":string[],'
  + '"gaps":string[],"hardRejection":boolean}]} with exactly one entry per vacancy.';

const models = createModels();
models.setProvider(claudeCliProvider({ defaultTimeoutMs: 300_000 }));

const repeats = Number(process.argv[2] ?? 3);
const candidates = (process.argv[3] ?? 'claude-haiku-4-5-20251001,claude-sonnet-5,claude-opus-5').split(',');
const efforts = (process.argv[4] ?? 'medium').split(',') as ThinkingLevel[];

interface Run { ok: boolean; ms: number; cost: number; input: number; output: number;
  scores?: Record<number, number>; rejects?: number[]; issue?: string }

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const spread = (xs: number[]): number => (xs.length < 2 ? 0 : Math.max(...xs) - Math.min(...xs));

for (const id of candidates) for (const effort of efforts) {
  const model = models.getModel('claude-cli', id);
  if (!model) { console.error(`${id}: not registered`); continue; }
  const runs: Run[] = [];
  for (let attempt = 0; attempt < repeats; attempt++) {
    const started = Date.now();
    try {
      const response = await models.completeSimple(model, {
        systemPrompt, messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      }, { reasoning: effort });
      const ms = Date.now() - started;
      if (response.stopReason !== 'stop') {
        runs.push({ ok: false, ms, cost: response.usage.cost.total, input: response.usage.input,
          output: response.usage.output, issue: `${response.stopReason}: ${response.errorMessage ?? ''}`.slice(0, 90) });
        continue;
      }
      const parsed = v.safeParse(scoringResultSchema, jsonText(contentText(response.content)));
      if (!parsed.success) {
        runs.push({ ok: false, ms, cost: response.usage.cost.total, input: response.usage.input,
          output: response.usage.output, issue: parsed.issues.slice(0, 2)
            .map((i) => `${v.getDotPath(i) ?? '(root)'}: ${i.message}`).join('; ').slice(0, 90) });
        continue;
      }
      const entries = Array.isArray(parsed.output) ? parsed.output : parsed.output.scores;
      runs.push({ ok: true, ms, cost: response.usage.cost.total, input: response.usage.input,
        output: response.usage.output,
        scores: Object.fromEntries(entries.map((e) => [e.vacancyId, e.score])),
        rejects: entries.filter((e) => e.hardRejection).map((e) => e.vacancyId) });
    } catch (error) {
      runs.push({ ok: false, ms: Date.now() - started, cost: 0, input: 0, output: 0,
        issue: (error instanceof Error ? error.message : String(error)).slice(0, 90) });
    }
  }
  const good = runs.filter((r) => r.ok);
  const perVacancy = vacancies.map((vacancy) => {
    const values = good.map((r) => r.scores?.[vacancy.id]).filter((x): x is number => typeof x === 'number');
    return { id: vacancy.id, median: values.length ? median(values) : null, spread: spread(values) };
  });
  console.info(JSON.stringify({
    model: id,
    effort,
    valid: `${good.length}/${runs.length}`,
    medianMs: good.length ? Math.round(median(good.map((r) => r.ms))) : null,
    maxMs: good.length ? Math.max(...good.map((r) => r.ms)) : null,
    costPerBatch: good.length ? Number((good.reduce((s, r) => s + r.cost, 0) / good.length).toFixed(5)) : null,
    tokens: good.length ? { in: Math.round(good.reduce((s, r) => s + r.input, 0) / good.length),
      out: Math.round(good.reduce((s, r) => s + r.output, 0) / good.length) } : null,
    allScores: good.map((r) => vacancies.map((vacancy) => r.scores?.[vacancy.id] ?? -1).join('/')),
    scores: perVacancy,
    hardRejections: good.map((r) => (r.rejects ?? []).join(',') || 'none'),
    failures: runs.filter((r) => !r.ok).map((r) => r.issue),
  }));
}
process.exit(0);
