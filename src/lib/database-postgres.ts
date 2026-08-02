import { createHash, randomInt } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { config } from '../config.ts';
import type { ExtractedCvDocument } from './cv-adapters.ts';
import type {
  AccessRequestResult, AlertVacancy, CvSource, DeliverySettings, PrefilterCalibration, PrefilteredVacancy,
  PrefilterScoreInput, ScoredVacancy, TelegramIdentity, TelegramUser, UsageKind, UserUsageSummary, Vacancy,
  VacancyCandidate, VacancyCandidateInput, VacancyInput,
} from './database-sqlite.ts';
import { postgresQuery, withPostgresTransaction } from './postgres.ts';
import { safeVacancyUrl } from './url-security.ts';
import { careerProfilePlatformId } from './career-profile.ts';

type Row = QueryResultRow & Record<string, unknown>;
const now = (): string => new Date().toISOString();
const q = <T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> => postgresQuery<T>(text, params);
const one = async <T extends Row = Row>(text: string, params: unknown[] = []): Promise<T | undefined> => (await q<T>(text, params))[0];
const txq = async <T extends Row = Row>(client: PoolClient, text: string, params: unknown[] = []): Promise<T[]> =>
  (await client.query<T>(text, params)).rows;

const initialization = (async () => {
  if (!config.telegramUserId) return;
  const timestamp = now();
  await q(`insert into telegram_users(user_id,chat_id,display_name,status,is_owner,approved_at,updated_at)
    values ($1,$2,'Owner','approved',1,$3,$3) on conflict(user_id) do update set chat_id=excluded.chat_id,
    status='approved',is_owner=1,approved_at=coalesce(telegram_users.approved_at,excluded.approved_at),updated_at=excluded.updated_at`,
    [config.telegramUserId, config.telegramChatId ?? config.telegramUserId, timestamp]);
})();
const ready = async (): Promise<void> => initialization;

function rowToUser(row: Row): TelegramUser {
  return { userId: String(row.user_id), chatId: String(row.chat_id), username: row.username == null ? null : String(row.username),
    displayName: String(row.display_name), status: String(row.status) as TelegramUser['status'], isOwner: Boolean(row.is_owner),
    requestedAt: row.requested_at == null ? null : String(row.requested_at),
    approvedAt: row.approved_at == null ? null : String(row.approved_at) };
}
export async function getTelegramUser(userId: string): Promise<TelegramUser | null> {
  await ready(); const row = await one('select * from telegram_users where user_id=$1', [userId]); return row ? rowToUser(row) : null;
}
export async function isApprovedUser(userId: string): Promise<boolean> {
  const user = await getTelegramUser(userId); return Boolean(user && (user.status === 'approved' || user.isOwner));
}
export async function requireApprovedUser(userId: string): Promise<TelegramUser> {
  const user = await getTelegramUser(userId);
  if (!user || (user.status !== 'approved' && !user.isOwner)) throw new Error('User access is not approved.');
  return user;
}
export async function touchTelegramUser(identity: TelegramIdentity): Promise<TelegramUser> {
  await ready(); const timestamp = now();
  const [row] = await q(`insert into telegram_users(user_id,chat_id,username,display_name,status,updated_at)
    values ($1,$2,$3,$4,'unregistered',$5) on conflict(user_id) do update set chat_id=excluded.chat_id,
    username=excluded.username,display_name=excluded.display_name,updated_at=excluded.updated_at returning *`,
    [identity.userId, identity.chatId, identity.username ?? null, identity.displayName, timestamp]);
  return rowToUser(row!);
}
export async function requestAccess(identity: TelegramIdentity): Promise<AccessRequestResult> {
  const current = await touchTelegramUser(identity);
  if (current.isOwner || current.status === 'approved' || current.status === 'pending') {
    return { user: current, notifyOwner: false, retryAfterSeconds: 0 };
  }
  const remaining = (current.requestedAt ? Date.parse(current.requestedAt) : 0)
    + config.accessRequestCooldownMinutes * 60_000 - Date.now();
  if ((current.status === 'rejected' || current.status === 'revoked') && remaining > 0) {
    return { user: current, notifyOwner: false, retryAfterSeconds: Math.ceil(remaining / 1_000) };
  }
  const timestamp = now();
  const [row] = await q(`update telegram_users set status='pending',requested_at=$1,updated_at=$1 where user_id=$2 returning *`,
    [timestamp, identity.userId]);
  return { user: rowToUser(row!), notifyOwner: true, retryAfterSeconds: 0 };
}
export async function setUserStatus(userId: string, status: 'approved' | 'rejected' | 'revoked'): Promise<TelegramUser | null> {
  await ready(); const timestamp = now();
  return withPostgresTransaction(async (client) => {
    const rows = await txq(client, `update telegram_users set status=case when is_owner<>0 then 'approved' else $1 end,
      approved_at=case when $1='approved' then $2 else approved_at end,
      requested_at=case when $1 in ('rejected','revoked') then $2 else requested_at end,updated_at=$2
      where user_id=$3 returning *`, [status, timestamp, userId]);
    if (status !== 'approved') await client.query('delete from pending_deliveries where user_id=$1', [userId]);
    return rows[0] ? rowToUser(rows[0]) : null;
  });
}
export async function listTelegramUsers(limit: number, offset: number): Promise<{ users: TelegramUser[]; total: number }> {
  await ready(); const [rows, count] = await Promise.all([
    q(`select * from telegram_users order by is_owner desc,case status when 'pending' then 0 when 'approved' then 1 else 2 end,
      updated_at desc limit $1 offset $2`, [limit, offset]), one('select count(*) count from telegram_users')]);
  return { users: rows.map(rowToUser), total: Number(count?.count ?? 0) };
}
export async function approvedUsers(requireCv = false): Promise<TelegramUser[]> {
  await ready(); const cv = requireCv ? 'and exists (select 1 from cv_templates c where c.user_id=u.user_id)' : '';
  return (await q(`select u.* from telegram_users u where u.status='approved' ${cv} order by u.is_owner desc,u.user_id`)).map(rowToUser);
}
async function hasCv(userId: string, client?: PoolClient): Promise<boolean> {
  const rows = client ? await txq(client, 'select 1 from cv_templates where user_id=$1', [userId])
    : await q('select 1 from cv_templates where user_id=$1', [userId]);
  return Boolean(rows.length);
}
export async function recordUsage(userId: string, kind: UsageKind): Promise<void> {
  await ready(); if (!await hasCv(userId)) throw new Error('An authoritative CV source is required.');
  await q('insert into usage_events(user_id,kind,occurred_at) values ($1,$2,$3)', [userId, kind, now()]);
}
export async function usageInLast24Hours(userId: string, kind: UsageKind): Promise<number> {
  await ready(); const row = await one(`select count(*) count from usage_events where user_id=$1 and kind=$2
    and occurred_at::timestamptz>=now()-interval '1 day'`, [userId, kind]); return Number(row?.count ?? 0);
}
export async function userUsageSummaries(): Promise<UserUsageSummary[]> {
  await ready(); const rows = await q(`select u.user_id,u.display_name,
    count(*) filter(where e.kind='score' and e.occurred_at::timestamptz>=now()-interval '1 day') scores_24h,
    count(*) filter(where e.kind='application' and e.occurred_at::timestamptz>=now()-interval '1 day') applications_24h,
    count(*) filter(where e.kind='search-profile' and e.occurred_at::timestamptz>=now()-interval '1 day') profiles_24h,
    count(*) filter(where e.kind='score') scores_total,count(*) filter(where e.kind='application') applications_total
    from telegram_users u left join usage_events e on e.user_id=u.user_id group by u.user_id,u.display_name
    order by max(u.is_owner) desc,u.user_id`);
  return rows.map((row) => ({ userId: String(row.user_id), displayName: String(row.display_name), scores24h: Number(row.scores_24h),
    applications24h: Number(row.applications_24h), searchProfiles24h: Number(row.profiles_24h), scoresTotal: Number(row.scores_total),
    applicationsTotal: Number(row.applications_total) }));
}

export async function purgeSettledAgentSession(agentName: string, sessionId: string): Promise<boolean> {
  await ready(); const sessionKey = `agent-session:${JSON.stringify([agentName, sessionId, 'default', 'default'])}`;
  return withPostgresTransaction(async (client) => {
    const submissions = await txq(client, 'select submission_id,status from flue_agent_submissions where session_key=$1 for update', [sessionKey]);
    if (!submissions.length || submissions.some((row) => !['settled', 'joined'].includes(String(row.status)))) return false;
    const path = `agents/${agentName}/${sessionId}`; const ids = submissions.map((row) => String(row.submission_id));
    await client.query('delete from flue_submission_chunks where submission_id=any($1::text[])', [ids]);
    await client.query('delete from flue_conversation_stream_batches where submission_id=any($1::text[])', [ids]);
    await client.query('delete from flue_attachments where stream_path=$1', [path]);
    await client.query('delete from flue_conversation_stream_batches where path=$1', [path]);
    await client.query('delete from flue_conversation_streams where path=$1', [path]);
    await client.query('delete from flue_agent_submissions where session_key=$1', [sessionKey]);
    return true;
  });
}
export async function purgeSettledAgentSessions(): Promise<number> {
  await ready(); const rows = await q(`select session_key from flue_agent_submissions group by session_key
    having count(*) filter(where status not in ('settled','joined'))=0`); let purged = 0;
  for (const row of rows) { const key = String(row.session_key); if (!key.startsWith('agent-session:')) continue;
    try { const value = JSON.parse(key.slice(14)) as unknown; if (Array.isArray(value) && typeof value[0] === 'string'
      && typeof value[1] === 'string' && await purgeSettledAgentSession(value[0], value[1])) purged++; } catch { /* incompatible key */ } }
  return purged;
}
export async function deleteUserData(userId: string): Promise<void> {
  await ready(); await withPostgresTransaction(async (client) => {
    for (const table of ['candidate_prefilter_scores','candidate_discoveries','pending_deliveries','user_delivery_windows','applications','scores',
      'prefilter_scores','user_vacancies','search_profiles','cv_templates','usage_events','telegram_sessions','background_tasks'] as const) {
      await client.query(`delete from ${table} where user_id=$1`, [userId]);
    }
    await client.query("delete from embedding_cache where kind='cv' and user_id=$1", [userId]);
    await client.query('delete from telegram_user_update_leases where user_id=$1', [userId]);
    await client.query('update llm_cost_events set user_id=null where user_id=$1', [userId]);
    const sessionPattern = `%"${userId.replaceAll('%', '\\%').replaceAll('_', '\\_')}-%`;
    const submissions = await txq(client, "select submission_id from flue_agent_submissions where session_key like $1 escape '\\'", [sessionPattern]);
    const ids = submissions.map((row) => String(row.submission_id));
    if (ids.length) { await client.query('delete from flue_submission_chunks where submission_id=any($1::text[])', [ids]);
      await client.query('delete from flue_conversation_stream_batches where submission_id=any($1::text[])', [ids]);
      await client.query('delete from flue_agent_submissions where submission_id=any($1::text[])', [ids]); }
    const streamPattern = `%/${userId.replaceAll('%', '\\%').replaceAll('_', '\\_')}-%`;
    const paths = (await txq(client, "select path from flue_conversation_streams where path like $1 escape '\\'", [streamPattern]))
      .map((row) => String(row.path));
    if (paths.length) { await client.query('delete from flue_attachments where stream_path=any($1::text[])', [paths]);
      await client.query('delete from flue_conversation_stream_batches where path=any($1::text[])', [paths]);
      await client.query('delete from flue_conversation_streams where path=any($1::text[])', [paths]); }
  });
}
export async function exportUserData(userId: string): Promise<Record<string, unknown>> {
  await ready(); if (!await getTelegramUser(userId)) throw new Error('User was not found.');
  const [cv, profiles, scores] = await Promise.all([one('select cv_text,document_json from cv_templates where user_id=$1', [userId]),
    q('select platform,profile_json from search_profiles where user_id=$1 order by platform', [userId]),
    q('select v.url,s.score from scores s join vacancies v on v.id=s.vacancy_id where s.user_id=$1 order by s.score desc,v.url', [userId])]);
  const careerRow = profiles.find((row) => String(row.platform) === careerProfilePlatformId);
  return { cvSource: cv ? String(cv.cv_text) : null, normalizedDocument: cv ? JSON.parse(String(cv.document_json)) : null,
    careerProfile: careerRow ? (JSON.parse(String(careerRow.profile_json)) as { profile?: unknown }).profile ?? null : null,
    searchProfiles: profiles.filter((row) => String(row.platform) !== careerProfilePlatformId)
      .map((row) => ({ platform: String(row.platform), profile: JSON.parse(String(row.profile_json)) })),
    scores: scores.map((row) => ({ url: String(row.url), score: Number(row.score) })) };
}

function rowToVacancy(row: Row): Vacancy {
  const source = String(row.source ?? 'hh'); return { id: Number(row.id), source, sourceId: String(row.source_id ?? row.hh_id),
    applyId: String(row.apply_id), name: String(row.name), employer: String(row.employer), area: String(row.area),
    salaryFrom: row.salary_from == null ? null : Number(row.salary_from), salaryTo: row.salary_to == null ? null : Number(row.salary_to),
    salaryCurrency: row.salary_currency == null ? null : String(row.salary_currency), salaryGross: row.salary_gross == null ? null : Boolean(row.salary_gross),
    experience: String(row.experience), employment: String(row.employment), schedule: String(row.schedule), workFormat: String(row.work_format),
    description: String(row.description), keySkills: JSON.parse(String(row.key_skills_json)) as string[], url: safeVacancyUrl(source, String(row.url)),
    publishedAt: String(row.published_at), sourceQuery: String(row.source_query), contentHash: String(row.content_hash),
    decision: String(row.user_decision ?? row.decision ?? 'new') };
}
export async function getCvSource(userId: string): Promise<CvSource | null> {
  await ready(); const row = await one(`select cv_sha256,cv_text,document_json,source_format,original_filename,media_type,parser_name,parser_version
    from cv_templates where user_id=$1`, [userId]);
  return row ? { cvSha256: String(row.cv_sha256), cvText: String(row.cv_text), document: JSON.parse(String(row.document_json)),
    sourceFormat: String(row.source_format) as CvSource['sourceFormat'], originalFilename: String(row.original_filename),
    mediaType: String(row.media_type), parserName: String(row.parser_name), parserVersion: String(row.parser_version) } : null;
}
export async function getCvHash(userId: string): Promise<string | null> {
  await ready(); const row = await one('select cv_sha256 from cv_templates where user_id=$1', [userId]); return row ? String(row.cv_sha256) : null;
}
export async function saveCvSource(userId: string, originalFilename: string, cvSha256: string, extracted: ExtractedCvDocument): Promise<void> {
  await ready(); await withPostgresTransaction(async (client) => {
    await client.query(`insert into cv_templates(user_id,cv_sha256,cv_text,document_json,source_format,original_filename,media_type,parser_name,parser_version,updated_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(user_id) do update set cv_sha256=excluded.cv_sha256,cv_text=excluded.cv_text,
      document_json=excluded.document_json,source_format=excluded.source_format,original_filename=excluded.original_filename,
      media_type=excluded.media_type,parser_name=excluded.parser_name,parser_version=excluded.parser_version,updated_at=excluded.updated_at`,
      [userId, cvSha256, extracted.text, JSON.stringify(extracted.document), extracted.sourceFormat, originalFilename,
        extracted.mediaType, extracted.parserName, extracted.parserVersion, now()]);
    await client.query('delete from scores where user_id=$1', [userId]); await client.query('delete from prefilter_scores where user_id=$1', [userId]);
  });
}
export async function saveSearchProfile(userId: string, platform: string, profile: unknown): Promise<void> {
  await ready(); if (!await hasCv(userId)) throw new Error('An authoritative CV source is required.');
  await q(`insert into search_profiles(user_id,platform,profile_json,updated_at) values($1,$2,$3,$4)
    on conflict(user_id,platform) do update set profile_json=excluded.profile_json,updated_at=excluded.updated_at`,
    [userId, platform, JSON.stringify(profile), now()]);
}
export async function clearSearchProfile(userId: string, platform: string): Promise<void> { await ready(); await q('delete from search_profiles where user_id=$1 and platform=$2', [userId, platform]); }
export async function getSearchProfile<T>(userId: string, platform: string): Promise<T | null> {
  await ready(); const row = await one('select profile_json from search_profiles where user_id=$1 and platform=$2', [userId, platform]);
  return row ? JSON.parse(String(row.profile_json)) as T : null;
}
export async function getDeliverySettings(userId: string): Promise<DeliverySettings | null> {
  await ready(); const row = await one('select start_minutes,end_minutes,digest_minutes,timezone,last_digest_at from user_delivery_windows where user_id=$1', [userId]);
  return row ? { startMinutes: Number(row.start_minutes), endMinutes: Number(row.end_minutes), digestMinutes: Number(row.digest_minutes),
    timezone: String(row.timezone), lastDigestAt: row.last_digest_at == null ? null : String(row.last_digest_at) } : null;
}
export async function saveDeliverySettings(userId: string, settings: Omit<DeliverySettings, 'lastDigestAt'>): Promise<void> {
  await ready(); await q(`insert into user_delivery_windows(user_id,start_minutes,end_minutes,digest_minutes,timezone,last_digest_at,updated_at)
    values($1,$2,$3,$4,$5,null,$6) on conflict(user_id) do update set start_minutes=excluded.start_minutes,end_minutes=excluded.end_minutes,
    digest_minutes=excluded.digest_minutes,timezone=excluded.timezone,updated_at=excluded.updated_at`,
    [userId, settings.startMinutes, settings.endMinutes, settings.digestMinutes, settings.timezone, now()]);
}
export async function markDigestRun(userId: string, deliveredAt: string): Promise<void> {
  await ready(); await q(`insert into user_delivery_windows(user_id,start_minutes,end_minutes,digest_minutes,timezone,last_digest_at,updated_at)
    values($1,0,0,540,$2,$3,$3) on conflict(user_id) do update set last_digest_at=excluded.last_digest_at,updated_at=excluded.updated_at`,
    [userId, config.timezone, deliveredAt]);
}

function newApplyId(): string { return Array.from({ length: 6 }, () => String.fromCharCode(97 + randomInt(26))).join(''); }
function canonicalFingerprint(name: string, employer: string): string {
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return createHash('sha256').update(`${normalize(name)}|${normalize(employer)}`).digest('hex');
}
function descriptionSimilarity(left: string, right: string): number {
  const tokens = (value: string) => new Set(value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const a = tokens(left), b = tokens(right); if (!a.size || !b.size) return 0; let count = 0; for (const token of a) if (b.has(token)) count++;
  return count / (a.size + b.size - count);
}
export async function upsertVacancy(input: VacancyInput): Promise<{ id: number; needsScore: boolean; duplicate: boolean }> {
  await ready(); const v = { ...input, url: safeVacancyUrl(input.source, input.url) }; const timestamp = now();
  return withPostgresTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext('vacancy:' || $1 || ':' || $2))", [v.source, v.sourceId]);
    const existing = (await txq(client, 'select id,content_hash from vacancies where source=$1 and source_id=$2 for update', [v.source, v.sourceId]))[0];
    const values = [v.name,v.employer,v.area,v.salaryFrom,v.salaryTo,v.salaryCurrency,v.salaryGross == null ? null : Number(v.salaryGross),
      v.experience,v.employment,v.schedule,v.workFormat,v.description,JSON.stringify(v.keySkills),v.url,v.publishedAt,v.sourceQuery,v.contentHash,timestamp];
    if (!existing) {
      const fingerprint = canonicalFingerprint(v.name, v.employer);
      const similar = (await txq(client, 'select id,description from vacancies where canonical_fingerprint=$1 order by id desc limit 10', [fingerprint]))
        .find((row) => descriptionSimilarity(String(row.description), v.description) >= 0.55);
      if (similar) return { id: Number(similar.id), needsScore: false, duplicate: true };
      await client.query("select pg_advisory_xact_lock(hashtext('vacancy-apply-id'))");
      let applyId = newApplyId();
      for (let attempt = 0; attempt < 20; attempt++) {
        if (!(await txq(client, 'select 1 from vacancies where apply_id=$1', [applyId])).length) break;
        applyId = newApplyId();
      }
      if ((await txq(client, 'select 1 from vacancies where apply_id=$1', [applyId])).length) {
        throw new Error('Could not allocate a unique vacancy apply ID.');
      }
      const rows = await txq(client, `insert into vacancies(hh_id,source,source_id,apply_id,name,employer,area,salary_from,salary_to,
        salary_currency,salary_gross,experience,employment,schedule,work_format,description,key_skills_json,url,published_at,source_query,
        content_hash,canonical_fingerprint,first_seen_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) returning id`,
        [`${v.source}:${v.sourceId}`, v.source, v.sourceId, applyId, ...values.slice(0,17), fingerprint, timestamp, timestamp]);
      return { id: Number(rows[0]!.id), needsScore: true, duplicate: false };
    }
    const id = Number(existing.id), changed = String(existing.content_hash) !== v.contentHash;
    await client.query(`update vacancies set name=$1,employer=$2,area=$3,salary_from=$4,salary_to=$5,salary_currency=$6,salary_gross=$7,
      experience=$8,employment=$9,schedule=$10,work_format=$11,description=$12,key_skills_json=$13,url=$14,published_at=$15,source_query=$16,
      content_hash=$17,updated_at=$18 where id=$19`, [...values, id]);
    if (changed) { await client.query('delete from scores where vacancy_id=$1', [id]); await client.query('delete from prefilter_scores where vacancy_id=$1', [id]); }
    return { id, needsScore: changed, duplicate: false };
  });
}
export async function hasVacancySourceId(source: string, sourceId: string): Promise<boolean> {
  await ready(); return Boolean((await q('select 1 from vacancies where source=$1 and source_id=$2', [source, sourceId])).length);
}
function rowToCandidate(row: Row): VacancyCandidate {
  return { source: String(row.source), sourceId: String(row.source_id), url: String(row.url), searchName: String(row.search_name), title: String(row.title),
    summary: String(row.summary), publishedAt: String(row.published_at), payload: JSON.parse(String(row.payload_json)), listingHash: String(row.listing_hash),
    status: String(row.status), attempts: Number(row.attempts), combinedScore: row.combined_score == null ? null : Number(row.combined_score) };
}
export async function recordVacancyCandidate(userId: string, raw: VacancyCandidateInput): Promise<boolean> {
  await ready(); const input = { ...raw, url: safeVacancyUrl(raw.source, raw.url) }; const timestamp = now(), summary = input.summary ?? '';
  const publishedAt = input.publishedAt ?? timestamp, payload = JSON.stringify(input.payload ?? null);
  const hash = createHash('sha256').update(JSON.stringify([input.title, summary, input.url, payload])).digest('hex');
  return withPostgresTransaction(async (client) => {
    const vacancy = (await txq(client, 'select id from vacancies where source=$1 and source_id=$2', [input.source,input.sourceId]))[0];
    const existing = (await txq(client, 'select status,listing_hash from vacancy_candidates where source=$1 and source_id=$2 for update', [input.source,input.sourceId]))[0];
    const discovered = !existing && !vacancy;
    const changed = Boolean(existing && String(existing.listing_hash) !== hash);
    if (!existing) await client.query(`insert into vacancy_candidates(source,source_id,url,search_name,title,summary,published_at,payload_json,
      listing_hash,status,vacancy_id,first_seen_at,last_seen_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [input.source,input.sourceId,input.url,input.searchName,input.title,summary,publishedAt,payload,hash,vacancy?'normalized':'discovered',vacancy?.id??null,timestamp]);
    else { await client.query(`update vacancy_candidates set url=$1,search_name=$2,title=$3,
      summary=$4,published_at=$5,payload_json=$6,listing_hash=$7,last_seen_at=$8,prefilter_context_hash=case when $9 then null else prefilter_context_hash end,
      status=case when $9 and status in ('filtered','failed','queued','discovered') then 'discovered' else status end where source=$10 and source_id=$11`,
      [input.url,input.searchName,input.title,summary,publishedAt,payload,hash,timestamp,changed,input.source,input.sourceId]); }
    if (await hasCv(userId, client)) await client.query(`insert into candidate_discoveries(user_id,source,source_id,search_name,first_seen_at,last_seen_at)
      values($1,$2,$3,$4,$5,$5) on conflict(user_id,source,source_id) do update set search_name=excluded.search_name,last_seen_at=excluded.last_seen_at`,
      [userId,input.source,input.sourceId,input.searchName,timestamp]);
    if (changed) await client.query('delete from candidate_prefilter_scores where source=$1 and source_id=$2', [input.source,input.sourceId]);
    return discovered;
  });
}
export async function candidatesNeedingPrefilter(userId: string, contextHash: string, limit: number): Promise<VacancyCandidate[]> {
  await ready(); return (await q(`select c.* from vacancy_candidates c join candidate_discoveries d
    on d.source=c.source and d.source_id=c.source_id and d.user_id=$1 left join candidate_prefilter_scores p
    on p.user_id=d.user_id and p.source=c.source and p.source_id=c.source_id where c.status in ('discovered','queued','filtered','failed') and
    (p.source_id is null or p.context_hash<>$2 or p.listing_hash<>c.listing_hash or p.semantic_status='unavailable')
    order by d.last_seen_at desc limit $3`, [userId,contextHash,limit])).map(rowToCandidate);
}
export async function saveCandidatePrefilter(userId: string, candidate: VacancyCandidate, contextHash: string, score: PrefilterScoreInput): Promise<void> {
  await ready(); await q(`insert into candidate_prefilter_scores(user_id,source,source_id,context_hash,listing_hash,regex_score,lexical_cosine,
    semantic_cosine,semantic_status,combined_score,filtered,reasons_json,scored_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    on conflict(user_id,source,source_id) do update set context_hash=excluded.context_hash,listing_hash=excluded.listing_hash,
    regex_score=excluded.regex_score,lexical_cosine=excluded.lexical_cosine,semantic_cosine=excluded.semantic_cosine,
    semantic_status=excluded.semantic_status,combined_score=excluded.combined_score,filtered=excluded.filtered,
    reasons_json=excluded.reasons_json,scored_at=excluded.scored_at`,
    [userId,candidate.source,candidate.sourceId,contextHash,candidate.listingHash,score.regexScore,score.embeddingCosine,
      score.semanticCosine,score.semanticStatus,score.combinedScore,Number(score.filtered),JSON.stringify(score.reasons),now()]);
}
export async function rankedCandidateQueueForUsers(userIds: string[], perUserLimit: number): Promise<VacancyCandidate[]> {
  await ready(); const queues = await Promise.all(userIds.map(async (userId) => (await q(`select c.*,p.combined_score from vacancy_candidates c join candidate_discoveries d
    on d.source=c.source and d.source_id=c.source_id join candidate_prefilter_scores p
    on p.user_id=d.user_id and p.source=c.source and p.source_id=c.source_id where d.user_id=$1
    and c.status in ('discovered','queued','filtered','failed') and p.filtered=0 and
    (c.next_retry_at is null or c.next_retry_at<=$2) order by p.combined_score desc,c.published_at desc limit $3`,
    [userId,now(),perUserLimit])).map(rowToCandidate)));
  const selected = new Map<string,VacancyCandidate>(); for(let rank=0;rank<perUserLimit;rank++) for(const queue of queues) {
    const candidate=queue[rank]; if(candidate) selected.set(`${candidate.source}:${candidate.sourceId}`,candidate); }
  return [...selected.values()];
}
export async function candidatesDueForRefresh(limit: number, days: number): Promise<VacancyCandidate[]> {
  await ready(); const before = new Date(Date.now()-days*86_400_000).toISOString();
  return (await q(`select * from vacancy_candidates where status='normalized' and (last_checked_at is null or last_checked_at<$1)
    order by coalesce(last_checked_at,first_seen_at) limit $2`,[before,limit])).map(rowToCandidate);
}
export async function markCandidateNormalized(candidate: VacancyCandidate, vacancyId: number, duplicate=false): Promise<void> {
  await ready(); await q(`update vacancy_candidates set status=$1,vacancy_id=$2,attempts=attempts+1,last_checked_at=$3,last_error=null,next_retry_at=null
    where source=$4 and source_id=$5`,[duplicate?'duplicate':'normalized',vacancyId,now(),candidate.source,candidate.sourceId]);
}
export async function markCandidateClosed(candidate: VacancyCandidate): Promise<void> { await ready(); await q(`update vacancy_candidates set status='closed',
  attempts=attempts+1,last_checked_at=$1,last_error=null where source=$2 and source_id=$3`,[now(),candidate.source,candidate.sourceId]); }
export async function markCandidateFailed(candidate: VacancyCandidate, error: string): Promise<void> {
  await ready(); const attempts=candidate.attempts+1, delay=Math.min(1440,2**Math.min(attempts,10));
  await q(`update vacancy_candidates set status='failed',attempts=$1,last_checked_at=$2,last_error=$3,next_retry_at=$4 where source=$5 and source_id=$6`,
    [attempts,now(),error.slice(0,1000),new Date(Date.now()+delay*60_000).toISOString(),candidate.source,candidate.sourceId]);
}

export async function getVacancy(id: number): Promise<Vacancy|null> {
  await ready(); const row=await one('select * from vacancies where id=$1',[id]); return row?rowToVacancy(row):null;
}
async function ensureUserVacancy(userId:string,vacancyId:number,client?:PoolClient):Promise<void>{
  const sql=`insert into user_vacancies(user_id,vacancy_id,first_relevant_at,updated_at) values($1,$2,$3,$3) on conflict do nothing`;
  if(client) await client.query(sql,[userId,vacancyId,now()]); else await q(sql,[userId,vacancyId,now()]);
}
export async function pendingVacancies(userId:string,limit:number):Promise<Vacancy[]>{ await ready(); return (await q(`select v.*,coalesce(uv.decision,'new') user_decision
  from vacancies v left join scores s on s.user_id=$1 and s.vacancy_id=v.id left join user_vacancies uv on uv.user_id=$1 and uv.vacancy_id=v.id
  where s.vacancy_id is null and coalesce(uv.decision,'new') not in ('skipped','applied') and exists (select 1 from vacancy_candidates c
  join candidate_discoveries d on d.source=c.source and d.source_id=c.source_id where c.vacancy_id=v.id and d.user_id=$1)
  order by v.published_at desc limit $2`,[userId,limit])).map(rowToVacancy); }
export async function vacanciesNeedingPrefilter(userId:string,contextHash:string,limit:number,semanticRequired=false):Promise<Vacancy[]>{
  await ready(); return (await q(`select v.*,coalesce(uv.decision,'new') user_decision from vacancies v
    left join scores s on s.user_id=$1 and s.vacancy_id=v.id left join prefilter_scores p on p.user_id=$1 and p.vacancy_id=v.id
    left join user_vacancies uv on uv.user_id=$1 and uv.vacancy_id=v.id where s.vacancy_id is null and coalesce(uv.decision,'new') not in ('skipped','applied')
    and exists (select 1 from vacancy_candidates c join candidate_discoveries d on d.source=c.source and d.source_id=c.source_id
      where c.vacancy_id=v.id and d.user_id=$1)
    and (p.vacancy_id is null or p.context_hash<>$2 or p.content_hash<>v.content_hash or ($3 and p.semantic_status in ('disabled','unavailable')))
    order by v.published_at desc limit $4`,[userId,contextHash,semanticRequired,limit])).map(rowToVacancy);
}
export async function getCachedEmbedding(model:string,kind:'cv'|'vacancy',userId:string,contentHash:string):Promise<Float32Array|null>{
  await ready(); const row=await one('select dimensions,vector from embedding_cache where model=$1 and kind=$2 and user_id=$3 and content_hash=$4',
    [model,kind,userId,contentHash]); if(!row)return null; const buffer=Buffer.from(row.vector as Buffer),dimensions=Number(row.dimensions);
  return buffer.byteLength===dimensions*4?new Float32Array(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength)):null;
}
export async function saveCachedEmbedding(model:string,kind:'cv'|'vacancy',userId:string,contentHash:string,vector:Float32Array):Promise<void>{
  await ready(); const bytes=Buffer.from(vector.buffer,vector.byteOffset,vector.byteLength); await q(`insert into embedding_cache
    (model,kind,user_id,content_hash,dimensions,vector,created_at) values($1,$2,$3,$4,$5,$6,$7) on conflict(model,kind,user_id,content_hash)
    do update set dimensions=excluded.dimensions,vector=excluded.vector,created_at=excluded.created_at`,[model,kind,userId,contentHash,vector.length,bytes,now()]);
}
export async function savePrefilterScore(userId:string,vacancyId:number,contextHash:string,contentHash:string,score:PrefilterScoreInput):Promise<void>{
  await ready(); await withPostgresTransaction(async client=>{ if(!await hasCv(userId,client))throw new Error('An authoritative CV source is required.');
    await ensureUserVacancy(userId,vacancyId,client); await client.query(`insert into prefilter_scores(user_id,vacancy_id,context_hash,content_hash,
      regex_score,embedding_cosine,embedding_score,semantic_cosine,semantic_score,semantic_status,combined_score,filtered,audit_selected,reasons_json,scored_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) on conflict(user_id,vacancy_id) do update set context_hash=excluded.context_hash,
      content_hash=excluded.content_hash,regex_score=excluded.regex_score,embedding_cosine=excluded.embedding_cosine,embedding_score=excluded.embedding_score,
      semantic_cosine=excluded.semantic_cosine,semantic_score=excluded.semantic_score,semantic_status=excluded.semantic_status,combined_score=excluded.combined_score,
      filtered=excluded.filtered,audit_selected=excluded.audit_selected,reasons_json=excluded.reasons_json,scored_at=excluded.scored_at`,
      [userId,vacancyId,contextHash,contentHash,score.regexScore,score.embeddingCosine,score.embeddingScore,score.semanticCosine,score.semanticScore,
        score.semanticStatus,score.combinedScore,Number(score.filtered),Number(score.auditSelected),JSON.stringify(score.reasons),now()]); });
}
function rowsToPrefiltered(rows:Row[]):PrefilteredVacancy[]{return rows.map(row=>({...rowToVacancy(row),prefilterScore:Number(row.prefilter_score),auditSelected:Boolean(row.audit_selected)}));}
export async function rankedPendingVacancies(userId:string,contextHash:string,limit:number,auditSlots=0):Promise<PrefilteredVacancy[]>{
  await ready(); const query=async(filtered:boolean,queryLimit:number)=>rowsToPrefiltered(await q(`select v.*,uv.decision user_decision,p.combined_score prefilter_score,
    p.audit_selected from vacancies v join prefilter_scores p on p.user_id=$1 and p.vacancy_id=v.id left join scores s on s.user_id=$1 and s.vacancy_id=v.id
    join user_vacancies uv on uv.user_id=$1 and uv.vacancy_id=v.id where s.vacancy_id is null and uv.decision not in ('skipped','applied')
    and p.context_hash=$2 and p.content_hash=v.content_hash and p.filtered=$3 ${filtered?'and p.audit_selected<>0':''}
    order by p.combined_score desc,v.published_at desc limit $4`,[userId,contextHash,Number(filtered),queryLimit]));
  const audit=await query(true,Math.min(limit,auditSlots)); return [...await query(false,Math.max(0,limit-audit.length)),...audit];
}
export async function prefilterQueueStats(userId:string,contextHash:string):Promise<{queued:number;filtered:number;auditQueued:number}>{
  await ready(); const row=await one(`select count(*) filter(where p.filtered=0) queued,count(*) filter(where p.filtered<>0) filtered,
    count(*) filter(where p.filtered<>0 and p.audit_selected<>0) audit_queued from prefilter_scores p left join scores s
    on s.user_id=p.user_id and s.vacancy_id=p.vacancy_id where p.user_id=$1 and p.context_hash=$2
    and p.content_hash=(select content_hash from vacancies where id=p.vacancy_id) and s.vacancy_id is null`,[userId,contextHash]);
  return {queued:Number(row?.queued??0),filtered:Number(row?.filtered??0),auditQueued:Number(row?.audit_queued??0)};
}
export async function prefilterCalibration(userId:string,contextHash:string,alertScore:number,minimumLabels:number):Promise<PrefilterCalibration>{
  await ready(); const rows=await q(`select p.combined_score,p.filtered,p.audit_selected,s.score,uv.decision from prefilter_scores p
    join scores s on s.user_id=p.user_id and s.vacancy_id=p.vacancy_id join vacancies v on v.id=p.vacancy_id
    join user_vacancies uv on uv.user_id=p.user_id and uv.vacancy_id=p.vacancy_id where p.user_id=$1 and p.context_hash=$2 and p.content_hash=v.content_hash`,[userId,contextHash]);
  const compared=rows.length;let sumX=0,sumY=0,sumXY=0,sumXX=0,sumYY=0,audited=0,auditFalseNegatives=0,applied=0,skipped=0;
  for(const row of rows){const x=Number(row.combined_score),y=Number(row.score);sumX+=x;sumY+=y;sumXY+=x*y;sumXX+=x*x;sumYY+=y*y;
    if(row.audit_selected){audited++;if(y>=alertScore)auditFalseNegatives++;}if(row.decision==='applied'||row.decision==='applying')applied++;if(row.decision==='skipped')skipped++;}
  const denominator=Math.sqrt((compared*sumXX-sumX*sumX)*(compared*sumYY-sumY*sumY));
  const correlation=compared>=2&&denominator?(compared*sumXY-sumX*sumY)/denominator:null,feedbackLabels=applied+skipped;
  return {compared,correlation,audited,auditFalseNegatives,applied,skipped,feedbackLabels,readyForAdjustment:feedbackLabels>=minimumLabels};
}

export async function saveScore(userId:string,vacancyId:number,score:number,primaryTrack:string,summary:string,reasons:string[],gaps:string[],hardRejection:boolean):Promise<void>{
  await ready(); await withPostgresTransaction(async client=>{if(!await hasCv(userId,client))throw new Error('An authoritative CV source is required.');
    await ensureUserVacancy(userId,vacancyId,client); const timestamp=now(); await client.query(`insert into scores(user_id,vacancy_id,score) values($1,$2,$3)
      on conflict(user_id,vacancy_id) do update set score=excluded.score`,[userId,vacancyId,score]);
    const rows=await txq(client,`update user_vacancies set score_updated_at=$1,updated_at=case when decision in ('alerted','digested') then $1 else updated_at end,
      decision=case when decision in ('alerted','digested') then 'new' else decision end where user_id=$2 and vacancy_id=$3 returning decision`,[timestamp,userId,vacancyId]);
    if(score>=config.alertScore&&!hardRejection&&String(rows[0]?.decision??'new')==='new')await client.query(`insert into score_alert_details
      (user_id,vacancy_id,primary_track,summary,reasons_json,gaps_json) values($1,$2,$3,$4,$5,$6) on conflict(user_id,vacancy_id) do update
      set primary_track=excluded.primary_track,summary=excluded.summary,reasons_json=excluded.reasons_json,gaps_json=excluded.gaps_json`,
      [userId,vacancyId,primaryTrack,summary,JSON.stringify(reasons),JSON.stringify(gaps)]);
    else await client.query('delete from score_alert_details where user_id=$1 and vacancy_id=$2',[userId,vacancyId]); });
}
function rowToScoredVacancy(row:Row):ScoredVacancy{return {...rowToVacancy(row),userId:String(row.score_user_id??row.user_id),score:Number(row.score)};}
function rowToAlertVacancy(row:Row):AlertVacancy{return {...rowToScoredVacancy(row),primaryTrack:String(row.primary_track),summary:String(row.summary),
  reasons:JSON.parse(String(row.reasons_json)) as string[],gaps:JSON.parse(String(row.gaps_json)) as string[]};}
const scoredSelect=`select v.*,uv.decision user_decision,s.user_id score_user_id,s.score from vacancies v join scores s on s.vacancy_id=v.id
  join user_vacancies uv on uv.user_id=s.user_id and uv.vacancy_id=v.id`;
export async function getScoredVacancy(userId:string,id:number):Promise<ScoredVacancy|null>{await ready();const row=await one(`${scoredSelect} where s.user_id=$1 and v.id=$2`,[userId,id]);return row?rowToScoredVacancy(row):null;}
export async function getScoredVacancyByApplyId(userId:string,applyId:string):Promise<ScoredVacancy|null>{await ready();const row=await one(`${scoredSelect} where s.user_id=$1 and v.apply_id=$2`,[userId,applyId]);return row?rowToScoredVacancy(row):null;}
export async function searchScoredVacancies(userId:string,input:string,limit=10):Promise<ScoredVacancy[]>{
  await ready();const tokens=input.toLowerCase().match(/[\p{L}\p{N}+#.]{2,}/gu)?.slice(0,12)??[];if(!tokens.length)return[];
  const query=tokens.join(' ');return(await q(`${scoredSelect} where s.user_id=$1 and v.search_vector@@websearch_to_tsquery('simple',$2)
    order by ts_rank(v.search_vector,websearch_to_tsquery('simple',$2)) desc,s.score desc limit $3`,[userId,query,Math.max(1,Math.min(limit,30))])).map(rowToScoredVacancy);
}
export async function latestDigestVacanciesByApplyIdPrefix(userId:string,prefix:string):Promise<ScoredVacancy[]>{await ready();return(await q(`${scoredSelect}
  where s.user_id=$1 and uv.decision='digested' and uv.updated_at=(select max(updated_at) from user_vacancies where user_id=$1 and decision='digested')
  and v.apply_id like $2 order by s.score desc,v.published_at desc limit 2`,[userId,`${prefix}%`])).map(rowToScoredVacancy);}
export async function digestVacancies(userId:string,min:number,high:number,since:string|null):Promise<ScoredVacancy[]>{await ready();return(await q(`${scoredSelect}
  where s.user_id=$1 and s.score>=$2 and s.score<$3 and uv.decision='new' and uv.score_updated_at is not null
  and ($4::text is null or uv.score_updated_at::timestamptz>$4::timestamptz) order by s.score desc,v.published_at desc`,[userId,min,high,since])).map(rowToScoredVacancy);}
export async function unsentHighScoreVacancies(userId:string,minScore:number,limit=30):Promise<AlertVacancy[]>{await ready();return(await q(`select v.*,
  uv.decision user_decision,s.user_id score_user_id,s.score,d.primary_track,d.summary,d.reasons_json,d.gaps_json from vacancies v join scores s on s.vacancy_id=v.id
  join user_vacancies uv on uv.user_id=s.user_id and uv.vacancy_id=v.id join score_alert_details d on d.user_id=s.user_id and d.vacancy_id=s.vacancy_id
  where s.user_id=$1 and s.score>=$2 and uv.decision='new' order by s.score desc,v.published_at desc limit $3`,[userId,minScore,limit])).map(rowToAlertVacancy);}
export async function markAlerted(userId:string,id:number):Promise<void>{await ready();await withPostgresTransaction(async client=>{await client.query(`update user_vacancies
  set decision='alerted',updated_at=$1 where user_id=$2 and vacancy_id=$3 and decision='new'`,[now(),userId,id]);await client.query('delete from score_alert_details where user_id=$1 and vacancy_id=$2',[userId,id]);});}
export async function markDigested(userId:string,ids:number[]):Promise<void>{await ready();if(!ids.length)return;await q(`update user_vacancies set decision='digested',updated_at=$1
  where user_id=$2 and vacancy_id=any($3::bigint[]) and decision='new'`,[now(),userId,ids]);}
export async function skipVacancy(userId:string,id:number):Promise<void>{await ready();await withPostgresTransaction(async client=>{await ensureUserVacancy(userId,id,client);
  await client.query("update user_vacancies set decision='skipped',updated_at=$1 where user_id=$2 and vacancy_id=$3",[now(),userId,id]);});}
export async function beginApplication(userId:string,id:number):Promise<void>{await ready();await withPostgresTransaction(async client=>{await ensureUserVacancy(userId,id,client);const timestamp=now();
  await client.query(`insert into applications(user_id,vacancy_id,status,requested_at,updated_at) values($1,$2,'generating',$3,$3) on conflict(user_id,vacancy_id)
  do update set status='generating',error=null,updated_at=excluded.updated_at`,[userId,id,timestamp]);await client.query("update user_vacancies set decision='applying',updated_at=$1 where user_id=$2 and vacancy_id=$3",[timestamp,userId,id]);});}
export async function markApplicationReady(userId:string,id:number):Promise<void>{await ready();await q("update applications set status='ready',updated_at=$1 where user_id=$2 and vacancy_id=$3",[now(),userId,id]);}
export async function markApplicationDelivered(userId:string,id:number):Promise<void>{await ready();await q("update user_vacancies set decision='applied',updated_at=$1 where user_id=$2 and vacancy_id=$3",[now(),userId,id]);}
export async function failApplication(userId:string,id:number,error:string):Promise<void>{await ready();await withPostgresTransaction(async client=>{const timestamp=now();
  await client.query("update applications set status='failed',error=$1,updated_at=$2 where user_id=$3 and vacancy_id=$4",[error,timestamp,userId,id]);
  await client.query("update user_vacancies set decision='alerted',updated_at=$1 where user_id=$2 and vacancy_id=$3",[timestamp,userId,id]);});}
