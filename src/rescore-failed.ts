/**
 * Re-scores vacancies that the prefilter admitted for scoring but which never got a score, i.e. batches that failed
 * (API rejection, timeout, aborted cycle). It deliberately does not run the prefilter, so no new candidates are
 * pulled into scope — only the existing backlog is repaired.
 *
 *   bun src/rescore-failed.ts [batchPerUser] [maxMinutes]
 *
 * RESCORE_EXCLUDE_USERS: comma-separated user IDs to skip.
 */
import { approvedUsers, markedUnscoredVacancies } from './database.ts';
import { getPostgresPool } from './postgres.ts';
import { scoreBatch } from './workflows.ts';
import { mapConcurrent } from './concurrency.ts';
import { errorMessage } from './observability.ts';
import { llmUsageSince, llmUsageSnapshot } from './ai.ts';
import { config } from './config.ts';

const batchPerUser = Number(process.argv[2] ?? 12);
const maxMinutes = Number(process.argv[3] ?? 180);
const excluded = new Set((process.env.RESCORE_EXCLUDE_USERS ?? '').split(',').map((id) => id.trim()).filter(Boolean));
const deadline = Date.now() + maxMinutes * 60_000;
const usageBefore = llmUsageSnapshot();

async function outstanding(): Promise<Map<string, number>> {
  const { rows } = await getPostgresPool().query<{ user_id: string; pending: number }>(
    `select uv.user_id, count(*)::int pending from user_vacancies uv
     join users u on u.user_id = uv.user_id and u.status = 'approved'
     join profiles p on p.user_id = uv.user_id and p.cv_text is not null
     where uv.score is null and uv.decision not in ('skipped','applied')
       and uv.prefilter_scored_at is not null and uv.prefilter_filtered = 0
     group by uv.user_id order by uv.user_id`);
  return new Map(rows.filter((row) => !excluded.has(row.user_id)).map((row) => [row.user_id, Number(row.pending)]));
}

const total = (counts: Map<string, number>) => [...counts.values()].reduce((sum, n) => sum + n, 0);

const start = await outstanding();
console.info(`Model ${config.scoringModel} (${config.scoringThinkingLevel}), batch ${batchPerUser}/user/pass.`);
if (excluded.size) console.info(`Excluded users: ${[...excluded].join(', ')}`);
for (const [userId, pending] of start) console.info(`  user=${userId} outstanding=${pending}`);
console.info(`Outstanding to repair: ${total(start)}`);

let pass = 0; let repaired = 0; let idle = 0;
for (;;) {
  if (Date.now() > deadline) { console.warn(`Stopping: ${maxMinutes}-minute limit reached.`); break; }
  const counts = await outstanding();
  if (total(counts) === 0) { console.info('No outstanding failed scores remain.'); break; }

  pass++;
  const started = Date.now();
  let scored = 0; let failed = 0;
  for (const user of await approvedUsers()) {
    if (!counts.has(user.userId)) continue;
    const vacancies = await markedUnscoredVacancies(user.userId, batchPerUser);
    if (!vacancies.length) continue;
    const batches: (typeof vacancies)[] = [];
    for (let offset = 0; offset < vacancies.length; offset += config.scoreBatchSize) {
      batches.push(vacancies.slice(offset, offset + config.scoreBatchSize));
    }
    await mapConcurrent(batches, config.scoreAgentConcurrencyMin, async (batch) => {
      try { await scoreBatch(user.userId, batch); scored += batch.length; }
      catch (error) {
        failed += batch.length;
        console.error(`  user=${user.userId} batch [${batch.map((v) => v.id).join(',')}] failed: ${errorMessage(error)}`);
      }
    });
    console.info(`  user=${user.userId} scored=${scored} remaining=${counts.get(user.userId)}`);
  }
  repaired += scored;
  console.info(`pass ${pass}: scored=${scored} failed=${failed} outstanding=${total(counts)} `
    + `elapsed=${Math.round((Date.now() - started) / 1000)}s`);
  // Every batch failing means the provider is unhealthy; stop rather than burn quota on repeats.
  if (scored === 0) { if (++idle >= 2) { console.warn('Stopping: two consecutive passes scored nothing.'); break; } }
  else idle = 0;
}

const remaining = await outstanding();
console.info(`Done. repaired=${repaired} passes=${pass} outstandingRemaining=${total(remaining)}`);
console.info(`LLM usage ${JSON.stringify(llmUsageSince(usageBefore))}`);
process.exit(0);
