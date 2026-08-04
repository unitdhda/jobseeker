import { createHash, randomInt } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { config } from './config.ts';
import type { CanonicalCvDocument, CvSourceFormat, ExtractedCvDocument } from './cv.ts';


export type UserStatus = 'unregistered' | 'pending' | 'approved' | 'rejected' | 'revoked';
export interface TelegramUser {
  userId: string; chatId: string; username: string | null; displayName: string;
  status: UserStatus; isOwner: boolean; requestedAt: string | null; approvedAt: string | null;
}
export interface TelegramIdentity { userId: string; chatId: string; username?: string; displayName: string }
export interface AccessRequestResult { user: TelegramUser; notifyOwner: boolean; retryAfterSeconds: number }
export type UsageKind = 'score' | 'application' | 'search-profile';
export interface UserUsageSummary {
  userId: string; displayName: string; scores24h: number; applications24h: number;
  searchProfiles24h: number; scoresTotal: number; applicationsTotal: number;
}
export interface UsageHour { at:string; tokens:number; costUsd:number }
export interface LlmUsageSummary {
  turns24h:number;turnsTotal:number;tokens24h:number;tokensTotal:number;cost24hUsd:number;costTotalUsd:number;
  hourlyTimeline:UsageHour[];
}
export interface Vacancy {
  id: number; source: string; sourceId: string; applyId: string; name: string; employer: string; area: string;
  salaryFrom: number | null; salaryTo: number | null; salaryCurrency: string | null; salaryGross: boolean | null;
  experience: string; employment: string; schedule: string; workFormat: string; description: string; keySkills: string[];
  url: string; publishedAt: string; sourceQuery: string; contentHash: string; decision: string;
}
export interface VacancyInput extends Omit<Vacancy, 'id' | 'applyId' | 'decision'> {}
export interface CvSource {
  cvSha256: string; cvText: string; document: CanonicalCvDocument;
  sourceFormat: CvSourceFormat; originalFilename: string; mediaType: string; parserName: string; parserVersion: string;
}
export interface DeliverySettings {
  startMinutes: number; endMinutes: number; digestMinutes: number; timezone: string; lastDigestAt: string | null;
}
export interface VacancyCandidateInput {
  source: string; sourceId: string; url: string; searchName: string; title: string;
  summary?: string; publishedAt?: string; payload?: unknown;
}
export interface VacancyCandidate extends Omit<VacancyCandidateInput, 'summary' | 'publishedAt'> {
  summary: string; publishedAt: string; listingHash: string; status: string; attempts: number; combinedScore: number | null;
}
export interface PrefilterScoreInput {
  regexScore: number; lexicalCosine: number; lexicalScore: number; combinedScore: number;
  filtered: boolean; auditSelected: boolean; reasons: string[];
}
export interface PrefilteredVacancy extends Vacancy { prefilterScore: number; auditSelected: boolean }
export interface PrefilterCalibration {
  compared: number; correlation: number | null; audited: number; auditFalseNegatives: number;
  applied: number; skipped: number; feedbackLabels: number; readyForAdjustment: boolean;
}
export interface ScoredVacancy extends Vacancy { userId: string; score: number }
export interface AlertVacancy extends ScoredVacancy {
  primaryTrack: string; summary: string; reasons: string[]; gaps: string[];
}

import { postgresQuery, withPostgresTransaction } from './postgres.ts';
import { safeVacancyUrl } from './vacancies/http.ts';
import { careerProfilePlatformId } from './prefilter.ts';

type Row = QueryResultRow & Record<string, unknown>;
const now = (): string => new Date().toISOString();
const q = <T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> => postgresQuery<T>(text, params);
const one = async <T extends Row = Row>(text: string, params: unknown[] = []): Promise<T | undefined> => (await q<T>(text, params))[0];
const txq = async <T extends Row = Row>(client: PoolClient, text: string, params: unknown[] = []): Promise<T[]> =>
  (await client.query<T>(text, params)).rows;

const initialization = (async () => {
  if (!config.telegramUserId) return;
  const timestamp = now();
  await q(`insert into users(user_id,chat_id,display_name,status,is_owner,approved_at,updated_at)
    values ($1,$2,'Owner','approved',1,$3,$3) on conflict(user_id) do update set chat_id=excluded.chat_id,
    status='approved',is_owner=1,approved_at=coalesce(users.approved_at,excluded.approved_at),updated_at=excluded.updated_at`,
    [config.telegramUserId, config.telegramChatId ?? config.telegramUserId, timestamp]);
})();
const ready = async (): Promise<void> => initialization;
function jsonValue<T>(value: unknown): T { return (typeof value === 'string' ? JSON.parse(value) : value) as T; }
function isoTimestamp(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
function optionalIsoTimestamp(value: unknown): string | null { return value == null ? null : isoTimestamp(value); }
function validTimestamp(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  const timestamp = raw ? new Date(raw) : null;
  return timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.toISOString() : fallback;
}

function rowToUser(row: Row): TelegramUser {
  return { userId: String(row.user_id), chatId: String(row.chat_id), username: row.username == null ? null : String(row.username),
    displayName: String(row.display_name), status: String(row.status) as TelegramUser['status'], isOwner: Boolean(row.is_owner),
    requestedAt: optionalIsoTimestamp(row.requested_at), approvedAt: optionalIsoTimestamp(row.approved_at) };
}
export async function getTelegramUser(userId: string): Promise<TelegramUser | null> {
  await ready(); const row = await one('select * from users where user_id=$1', [userId]); return row ? rowToUser(row) : null;
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
  const [row] = await q(`insert into users(user_id,chat_id,username,display_name,status,updated_at)
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
  const [row] = await q(`update users set status='pending',requested_at=$1,updated_at=$1 where user_id=$2 returning *`,
    [timestamp, identity.userId]);
  return { user: rowToUser(row!), notifyOwner: true, retryAfterSeconds: 0 };
}
export async function setUserStatus(userId: string, status: 'approved' | 'rejected' | 'revoked'): Promise<TelegramUser | null> {
  await ready(); const timestamp = now();
  return withPostgresTransaction(async (client) => {
    const rows = await txq(client, `update users set status=case when is_owner<>0 then 'approved' else $1 end,
      approved_at=case when $1='approved' then $2 else approved_at end,
      requested_at=case when $1 in ('rejected','revoked') then $2 else requested_at end,updated_at=$2
      where user_id=$3 returning *`, [status, timestamp, userId]);
    return rows[0] ? rowToUser(rows[0]) : null;
  });
}
export async function listTelegramUsers(limit: number, offset: number): Promise<{ users: TelegramUser[]; total: number }> {
  await ready(); const [rows, count] = await Promise.all([
    q(`select * from users order by is_owner desc,case status when 'pending' then 0 when 'approved' then 1 else 2 end,
      updated_at desc limit $1 offset $2`, [limit, offset]), one('select count(*) count from users')]);
  return { users: rows.map(rowToUser), total: Number(count?.count ?? 0) };
}
export async function approvedUsers(requireCv = false): Promise<TelegramUser[]> {
  await ready(); const cv = requireCv ? 'and exists (select 1 from profiles p where p.user_id=u.user_id)' : '';
  return (await q(`select u.* from users u where u.status='approved' ${cv} order by u.is_owner desc,u.user_id`)).map(rowToUser);
}
async function hasCv(userId: string, client?: PoolClient): Promise<boolean> {
  const rows = client ? await txq(client, 'select 1 from profiles where user_id=$1', [userId])
    : await q('select 1 from profiles where user_id=$1', [userId]);
  return Boolean(rows.length);
}
export async function recordUsage(userId: string, kind: UsageKind): Promise<void> {
  await ready(); if (!await hasCv(userId)) throw new Error('An authoritative CV source is required.');
  await q('insert into usage_events(user_id,kind,occurred_at) values ($1,$2,$3)', [userId, kind, now()]);
}
export async function usageInLast24Hours(userId: string, kind: UsageKind): Promise<number> {
  await ready(); const row = await one(`select count(*) count from usage_events where user_id=$1 and kind=$2
    and occurred_at>=now()-interval '1 day'`, [userId, kind]); return Number(row?.count ?? 0);
}
export async function userUsageSummaries(): Promise<UserUsageSummary[]> {
  await ready(); const rows = await q(`select u.user_id,u.display_name,
    count(*) filter(where e.kind='score' and e.occurred_at>=now()-interval '1 day') scores_24h,
    count(*) filter(where e.kind='application' and e.occurred_at>=now()-interval '1 day') applications_24h,
    count(*) filter(where e.kind='search-profile' and e.occurred_at>=now()-interval '1 day') profiles_24h,
    count(*) filter(where e.kind='score') scores_total,count(*) filter(where e.kind='application') applications_total
    from users u left join usage_events e on e.user_id=u.user_id group by u.user_id,u.display_name
    order by max(u.is_owner) desc,u.user_id`);
  return rows.map((row) => ({ userId: String(row.user_id), displayName: String(row.display_name), scores24h: Number(row.scores_24h),
    applications24h: Number(row.applications_24h), searchProfiles24h: Number(row.profiles_24h), scoresTotal: Number(row.scores_total),
    applicationsTotal: Number(row.applications_total) }));
}

export async function llmUsageSummary():Promise<LlmUsageSummary>{
  await ready();const [totals,hours]=await Promise.all([
    one(`select count(*) filter(where kind='llm' and occurred_at>=now()-interval '1 day') turns_24h,
      count(*) filter(where kind='llm') turns_total,
      coalesce(sum(total_tokens) filter(where kind='llm' and occurred_at>=now()-interval '1 day'),0) tokens_24h,
      coalesce(sum(total_tokens) filter(where kind='llm'),0) tokens_total,
      coalesce(sum(cost_usd) filter(where kind='llm' and occurred_at>=now()-interval '1 day'),0) cost_24h,
      coalesce(sum(cost_usd) filter(where kind='llm'),0) cost_total from usage_events`),
    q(`with bounds as(select date_trunc('hour',now()) end_hour),hours as(
      select generate_series(end_hour-interval '24 hours',end_hour,interval '1 hour') bucket from bounds)
      select h.bucket,coalesce(sum(e.total_tokens),0) tokens,coalesce(sum(e.cost_usd),0) cost
      from hours h left join usage_events e on e.kind='llm' and e.occurred_at>=h.bucket
        and e.occurred_at<h.bucket+interval '1 hour' group by h.bucket order by h.bucket`),
  ]);return{
    turns24h:Number(totals?.turns_24h??0),turnsTotal:Number(totals?.turns_total??0),
    tokens24h:Number(totals?.tokens_24h??0),tokensTotal:Number(totals?.tokens_total??0),
    cost24hUsd:Number(totals?.cost_24h??0),costTotalUsd:Number(totals?.cost_total??0),
    hourlyTimeline:hours.map(row=>({at:isoTimestamp(row.bucket),tokens:Number(row.tokens),costUsd:Number(row.cost)})),
  };
}

export async function deleteUserData(userId: string): Promise<void> {
  await ready(); await withPostgresTransaction(async (client) => {
    for (const table of ['user_vacancies','profiles','usage_events','user_state'] as const) {
      await client.query(`delete from ${table} where user_id=$1`, [userId]);
    }
    await client.query(`update users set delivery_start_minutes=null,delivery_end_minutes=null,digest_minutes=null,
      delivery_timezone=null,last_digest_at=null where user_id=$1`, [userId]);

  });
}
export async function exportUserData(userId: string): Promise<Record<string, unknown>> {
  await ready(); if (!await getTelegramUser(userId)) throw new Error('User was not found.');
  const [profile, scores] = await Promise.all([one('select cv_text,document_json,search_profiles from profiles where user_id=$1', [userId]),
    q('select v.url,uv.score from user_vacancies uv join vacancies v on v.id=uv.vacancy_id where uv.user_id=$1 and uv.score is not null order by uv.score desc,v.url', [userId])]);
  const profiles = profile ? jsonValue<Record<string, unknown>>(profile.search_profiles) : {};
  const career = profiles[careerProfilePlatformId] as { profile?: unknown } | undefined;
  return { cvSource: profile ? String(profile.cv_text) : null, normalizedDocument: profile ? jsonValue(profile.document_json) : null,
    careerProfile: career?.profile ?? null,
    searchProfiles: Object.entries(profiles).filter(([platform]) => platform !== careerProfilePlatformId)
      .sort(([left], [right]) => left.localeCompare(right)).map(([platform, value]) => ({ platform, profile: value })),
    scores: scores.map((row) => ({ url: String(row.url), score: Number(row.score) })) };
}

function rowToVacancy(row: Row): Vacancy {
  const source = String(row.source ?? 'hh'); return { id: Number(row.id), source, sourceId: String(row.source_id),
    applyId: String(row.apply_id), name: String(row.name), employer: String(row.employer), area: String(row.area),
    salaryFrom: row.salary_from == null ? null : Number(row.salary_from), salaryTo: row.salary_to == null ? null : Number(row.salary_to),
    salaryCurrency: row.salary_currency == null ? null : String(row.salary_currency), salaryGross: row.salary_gross == null ? null : Boolean(row.salary_gross),
    experience: String(row.experience), employment: String(row.employment), schedule: String(row.schedule), workFormat: String(row.work_format),
    description: String(row.description), keySkills: jsonValue<string[]>(row.key_skills_json), url: safeVacancyUrl(source, String(row.url)),
    publishedAt: isoTimestamp(row.published_at), sourceQuery: String(row.source_query), contentHash: String(row.content_hash),
    decision: String(row.user_decision ?? 'new') };
}
export async function getCvSource(userId: string): Promise<CvSource | null> {
  await ready(); const row = await one(`select cv_sha256,cv_text,document_json,source_format,original_filename,media_type,parser_name,parser_version
    from profiles where user_id=$1`, [userId]);
  return row ? { cvSha256: String(row.cv_sha256), cvText: String(row.cv_text), document: jsonValue(row.document_json),
    sourceFormat: String(row.source_format) as CvSource['sourceFormat'], originalFilename: String(row.original_filename),
    mediaType: String(row.media_type), parserName: String(row.parser_name), parserVersion: String(row.parser_version) } : null;
}
export async function getCvHash(userId: string): Promise<string | null> {
  await ready(); const row = await one('select cv_sha256 from profiles where user_id=$1', [userId]); return row ? String(row.cv_sha256) : null;
}
export async function saveCvSource(userId: string, originalFilename: string, cvSha256: string, extracted: ExtractedCvDocument): Promise<void> {
  await ready(); await withPostgresTransaction(async (client) => {
    await client.query(`insert into profiles(user_id,cv_sha256,cv_text,document_json,source_format,original_filename,media_type,parser_name,parser_version,search_profiles,updated_at)
      values($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,'{}'::jsonb,$10) on conflict(user_id) do update set cv_sha256=excluded.cv_sha256,cv_text=excluded.cv_text,
      document_json=excluded.document_json,source_format=excluded.source_format,original_filename=excluded.original_filename,
      media_type=excluded.media_type,parser_name=excluded.parser_name,parser_version=excluded.parser_version,search_profiles='{}'::jsonb,updated_at=excluded.updated_at`,
      [userId, cvSha256, extracted.text, JSON.stringify(extracted.document), extracted.sourceFormat, originalFilename,
        extracted.mediaType, extracted.parserName, extracted.parserVersion, now()]);
    await client.query(`update user_vacancies set score=null,score_updated_at=null,
      prefilter_context_hash=null,prefilter_content_hash=null,prefilter_regex_score=null,prefilter_lexical_cosine=null,
      prefilter_lexical_score=null,prefilter_score=null,prefilter_filtered=null,prefilter_audit_selected=null,
      prefilter_reasons=null,prefilter_scored_at=null,alert_primary_track=null,alert_summary=null,alert_reasons=null,alert_gaps=null
      where user_id=$1`, [userId]);
  });
}
export async function saveSearchProfile(userId: string, platform: string, profile: unknown): Promise<void> {
  await ready(); if (!await hasCv(userId)) throw new Error('An authoritative CV source is required.');
  await q(`update profiles set search_profiles=jsonb_set(search_profiles,array[$2::text],$3::jsonb,true),updated_at=$4 where user_id=$1`,
    [userId, platform, JSON.stringify(profile), now()]);
}
export async function clearSearchProfile(userId: string, platform: string): Promise<void> {
  await ready(); await q('update profiles set search_profiles=search_profiles-$2,updated_at=$3 where user_id=$1', [userId, platform, now()]);
}
export async function getSearchProfile<T>(userId: string, platform: string): Promise<T | null> {
  await ready(); const row = await one('select search_profiles->$2 profile from profiles where user_id=$1', [userId, platform]);
  return row?.profile == null ? null : jsonValue<T>(row.profile);
}
export async function getDeliverySettings(userId: string): Promise<DeliverySettings | null> {
  await ready(); const row = await one(`select delivery_start_minutes,delivery_end_minutes,digest_minutes,delivery_timezone,last_digest_at
    from users where user_id=$1 and delivery_start_minutes is not null`, [userId]);
  return row ? { startMinutes: Number(row.delivery_start_minutes), endMinutes: Number(row.delivery_end_minutes), digestMinutes: Number(row.digest_minutes),
    timezone: String(row.delivery_timezone), lastDigestAt: optionalIsoTimestamp(row.last_digest_at) } : null;
}
export async function saveDeliverySettings(userId: string, settings: Omit<DeliverySettings, 'lastDigestAt'>): Promise<void> {
  await ready(); await q(`update users set delivery_start_minutes=$2,delivery_end_minutes=$3,digest_minutes=$4,
    delivery_timezone=$5,updated_at=$6 where user_id=$1`,
    [userId, settings.startMinutes, settings.endMinutes, settings.digestMinutes, settings.timezone, now()]);
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
  await ready(); const timestamp = now(); const v = { ...input, url: safeVacancyUrl(input.source, input.url),
    publishedAt: validTimestamp(input.publishedAt,timestamp) };
  return withPostgresTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext('vacancy:' || $1 || ':' || $2))", [v.source, v.sourceId]);
    const existing = (await txq(client, 'select id,apply_id,content_hash from vacancies where source=$1 and source_id=$2 for update',
      [v.source, v.sourceId]))[0];
    const id = existing ? Number(existing.id) : null, fingerprint = canonicalFingerprint(v.name,v.employer);
    const values = [v.name,v.employer,v.area,v.salaryFrom,v.salaryTo,v.salaryCurrency,v.salaryGross == null ? null : Number(v.salaryGross),
      v.experience,v.employment,v.schedule,v.workFormat,v.description,JSON.stringify(v.keySkills),v.url,v.publishedAt,v.sourceQuery,v.contentHash,timestamp];
    if (!existing?.apply_id) {
      const similar = (await txq(client, `select id,description from vacancies where canonical_fingerprint=$1
        and ($2::bigint is null or id<>$2) order by id desc limit 10`, [fingerprint,id]))
        .find((row) => descriptionSimilarity(String(row.description), v.description) >= 0.55);
      if (similar) return { id: Number(similar.id), needsScore: false, duplicate: true };
      await client.query("select pg_advisory_xact_lock(hashtext('vacancy-apply-id'))");
      let applyId = newApplyId();
      for (let attempt=0;attempt<20&&(await txq(client,'select 1 from vacancies where apply_id=$1',[applyId])).length;attempt++) applyId=newApplyId();
      if ((await txq(client,'select 1 from vacancies where apply_id=$1',[applyId])).length) throw new Error('Could not allocate a unique vacancy apply ID.');
      if (id != null) {
        await client.query(`update vacancies set apply_id=$1,name=$2,employer=$3,area=$4,salary_from=$5,salary_to=$6,salary_currency=$7,
          salary_gross=$8,experience=$9,employment=$10,schedule=$11,work_format=$12,description=$13,key_skills_json=$14::jsonb,url=$15,
          published_at=$16,source_query=$17,content_hash=$18,updated_at=$19,canonical_fingerprint=$20,lifecycle_status='normalized',
          normalized_vacancy_id=$21 where id=$21`,[applyId,...values,fingerprint,id]);
        return { id, needsScore: true, duplicate: false };
      }
      const rows=await txq(client,`insert into vacancies(source,source_id,apply_id,name,employer,area,salary_from,salary_to,salary_currency,
        salary_gross,experience,employment,schedule,work_format,description,key_skills_json,url,published_at,source_query,content_hash,
        canonical_fingerprint,first_seen_at,updated_at,lifecycle_status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,
        $17,$18,$19,$20,$21,$22,$23,'normalized') returning id`,[v.source,v.sourceId,applyId,...values.slice(0,17),fingerprint,timestamp,timestamp]);
      const insertedId=Number(rows[0]!.id); await client.query('update vacancies set normalized_vacancy_id=id where id=$1',[insertedId]);
      return { id: insertedId, needsScore: true, duplicate: false };
    }
    const normalizedId=Number(existing.id), changed=String(existing.content_hash)!==v.contentHash;
    await client.query(`update vacancies set name=$1,employer=$2,area=$3,salary_from=$4,salary_to=$5,salary_currency=$6,salary_gross=$7,
      experience=$8,employment=$9,schedule=$10,work_format=$11,description=$12,key_skills_json=$13::jsonb,url=$14,published_at=$15,source_query=$16,
      content_hash=$17,updated_at=$18,lifecycle_status='normalized',normalized_vacancy_id=$19 where id=$19`,[...values,normalizedId]);
    if (changed) await client.query(`update user_vacancies set score=null,score_updated_at=null,prefilter_context_hash=null,
      prefilter_content_hash=null,prefilter_regex_score=null,prefilter_lexical_cosine=null,prefilter_lexical_score=null,prefilter_score=null,
      prefilter_filtered=null,prefilter_audit_selected=null,prefilter_reasons=null,prefilter_scored_at=null,
      alert_primary_track=null,alert_summary=null,alert_reasons=null,alert_gaps=null where vacancy_id=$1`,[normalizedId]);
    return { id: normalizedId, needsScore: changed, duplicate: false };
  });
}
export async function hasVacancySourceId(source: string, sourceId: string): Promise<boolean> {
  await ready(); return Boolean((await q('select 1 from vacancies where source=$1 and source_id=$2 and apply_id is not null', [source, sourceId])).length);
}
function rowToCandidate(row: Row): VacancyCandidate {
  return { source: String(row.source), sourceId: String(row.source_id), url: String(row.url),
    searchName: String(row.discovery_search_name ?? row.listing_search_name), title: String(row.listing_title),
    summary: String(row.listing_summary ?? ''), publishedAt: isoTimestamp(row.published_at), payload: jsonValue(row.listing_payload),
    listingHash: String(row.listing_hash), status: String(row.lifecycle_status), attempts: Number(row.normalization_attempts),
    combinedScore: row.combined_score == null ? null : Number(row.combined_score) };
}
export async function recordVacancyCandidate(userId: string, raw: VacancyCandidateInput): Promise<boolean> {
  await ready(); const input = { ...raw, url: safeVacancyUrl(raw.source, raw.url) }; const timestamp = now(), summary = input.summary ?? '';
  const publishedAt = validTimestamp(input.publishedAt,timestamp), payload = JSON.stringify(input.payload ?? null);
  const hash = createHash('sha256').update(JSON.stringify([input.title, summary, input.url, payload])).digest('hex');
  return withPostgresTransaction(async (client) => {
    const existing=(await txq(client,'select id,apply_id,lifecycle_status,listing_hash,normalized_vacancy_id from vacancies where source=$1 and source_id=$2 for update',
      [input.source,input.sourceId]))[0];
    const discovered=!existing, changed=Boolean(existing&&String(existing.listing_hash)!==hash);
    if(!existing) await client.query(`insert into vacancies(source,source_id,url,published_at,first_seen_at,updated_at,listing_search_name,
      listing_title,listing_summary,listing_payload,listing_hash,lifecycle_status,last_seen_at) values($1,$2,$3,$4,$5,$5,$6,$7,$8,$9::jsonb,$10,'discovered',$5)`,
      [input.source,input.sourceId,input.url,publishedAt,timestamp,input.searchName,input.title,summary,payload,hash]);
    else await client.query(`update vacancies set url=$1,listing_search_name=$2,listing_title=$3,listing_summary=$4,published_at=$5,
      listing_payload=$6::jsonb,listing_hash=$7,last_seen_at=$8,updated_at=$8,lifecycle_status=case when $9 and apply_id is null
      and lifecycle_status in ('filtered','failed','queued','discovered') then 'discovered' else lifecycle_status end where id=$10`,
      [input.url,input.searchName,input.title,summary,publishedAt,payload,hash,timestamp,changed,existing.id]);
    if(await hasCv(userId,client)) {
      const normalizedId=existing?.normalized_vacancy_id==null?null:Number(existing.normalized_vacancy_id);
      let updated: QueryResultRow[]=[];
      if(normalizedId!=null) updated=await txq(client,`update user_vacancies set search_name=$1,
        discovered_at=coalesce(discovered_at,$2),last_discovered_at=$2 where user_id=$3 and vacancy_id=$4 returning user_id`,
        [input.searchName,timestamp,userId,normalizedId]);
      if(!updated.length) await client.query(`insert into user_vacancies(user_id,vacancy_id,source,source_id,search_name,discovered_at,
        last_discovered_at,first_relevant_at,updated_at) values($1,$2,$3,$4,$5,$6,$6,$6,$6)
        on conflict(user_id,source,source_id) do update set search_name=excluded.search_name,last_discovered_at=excluded.last_discovered_at`,
        [userId,normalizedId,input.source,input.sourceId,input.searchName,timestamp]);
    }
    if(changed) await client.query(`update user_vacancies set candidate_context_hash=null,candidate_listing_hash=null,
      candidate_regex_score=null,candidate_lexical_cosine=null,candidate_score=null,candidate_filtered=null,
      candidate_reasons=null,candidate_scored_at=null where source=$1 and source_id=$2`,[input.source,input.sourceId]);
    return discovered;
  });
}
export async function candidatesNeedingPrefilter(userId: string, contextHash: string, limit: number): Promise<VacancyCandidate[]> {
  await ready(); return (await q(`select c.*,d.search_name discovery_search_name from vacancies c join user_vacancies d
    on d.source=c.source and d.source_id=c.source_id and d.user_id=$1 where c.lifecycle_status in ('discovered','queued','filtered','failed') and
    (d.candidate_context_hash is null or d.candidate_context_hash<>$2 or d.candidate_listing_hash<>c.listing_hash)
    order by d.last_discovered_at desc limit $3`, [userId,contextHash,limit])).map(rowToCandidate);
}
export async function saveCandidatePrefilter(userId: string, candidate: VacancyCandidate, contextHash: string, score: PrefilterScoreInput): Promise<void> {
  await ready(); await q(`update user_vacancies set candidate_context_hash=$1,candidate_listing_hash=$2,candidate_regex_score=$3,
    candidate_lexical_cosine=$4,candidate_score=$5,candidate_filtered=$6,candidate_reasons=$7::jsonb,candidate_scored_at=$8
    where user_id=$9 and source=$10 and source_id=$11`,[contextHash,candidate.listingHash,score.regexScore,score.lexicalCosine,
      score.combinedScore,Number(score.filtered),JSON.stringify(score.reasons),now(),userId,candidate.source,candidate.sourceId]);
}
export async function rankedCandidateQueueForUsers(userIds: string[], perUserLimit: number): Promise<VacancyCandidate[]> {
  await ready(); const queues = await Promise.all(userIds.map(async (userId) => (await q(`select c.*,d.search_name discovery_search_name,
    d.candidate_score combined_score from vacancies c join user_vacancies d on d.source=c.source and d.source_id=c.source_id
    where d.user_id=$1 and c.lifecycle_status in ('discovered','queued','filtered','failed') and d.candidate_filtered=0 and
    (c.normalization_retry_at is null or c.normalization_retry_at<=$2) and c.source=any($4::text[])
    order by d.candidate_score desc,c.published_at desc limit $3`,
    [userId,now(),perUserLimit,config.searchPlatforms])).map(rowToCandidate)));
  const selected = new Map<string,VacancyCandidate>(); for(let rank=0;rank<perUserLimit;rank++) for(const queue of queues) {
    const candidate=queue[rank]; if(candidate) selected.set(`${candidate.source}:${candidate.sourceId}`,candidate); }
  return [...selected.values()];
}
export async function candidatesDueForRefresh(limit: number, days: number): Promise<VacancyCandidate[]> {
  await ready(); const before = new Date(Date.now()-days*86_400_000).toISOString();
  return (await q(`select * from vacancies where lifecycle_status='normalized' and (last_checked_at is null or last_checked_at<$1)
    and source=any($3::text[]) order by coalesce(last_checked_at,first_seen_at) limit $2`,
    [before,limit,config.searchPlatforms])).map(rowToCandidate);
}
export async function markCandidateNormalized(candidate: VacancyCandidate, vacancyId: number, duplicate=false): Promise<void> {
  await ready(); await withPostgresTransaction(async client=>{const timestamp=now();
    await client.query(`update vacancies set lifecycle_status=$1,normalized_vacancy_id=$2,normalization_attempts=normalization_attempts+1,
      last_checked_at=$3,normalization_error=null,normalization_retry_at=null where source=$4 and source_id=$5`,
      [duplicate?'duplicate':'normalized',vacancyId,timestamp,candidate.source,candidate.sourceId]);
    await client.query(`delete from user_vacancies candidate where candidate.source=$1 and candidate.source_id=$2
      and exists(select 1 from user_vacancies normalized where normalized.user_id=candidate.user_id
        and normalized.vacancy_id=$3 and (normalized.source<>candidate.source or normalized.source_id<>candidate.source_id))`,
      [candidate.source,candidate.sourceId,vacancyId]);
    await client.query(`update user_vacancies set vacancy_id=$1,updated_at=$2 where source=$3 and source_id=$4`,
      [vacancyId,timestamp,candidate.source,candidate.sourceId]);
  });
}
export async function markCandidateClosed(candidate: VacancyCandidate): Promise<void> { await ready(); await q(`update vacancies set lifecycle_status='closed',
  normalization_attempts=normalization_attempts+1,last_checked_at=$1,normalization_error=null where source=$2 and source_id=$3`,
  [now(),candidate.source,candidate.sourceId]); }
export async function markCandidateFailed(candidate: VacancyCandidate, error: string): Promise<void> {
  await ready(); const attempts=candidate.attempts+1, delay=Math.min(1440,2**Math.min(attempts,10));
  await q(`update vacancies set lifecycle_status='failed',normalization_attempts=$1,last_checked_at=$2,normalization_error=$3,
    normalization_retry_at=$4 where source=$5 and source_id=$6`,
    [attempts,now(),error.slice(0,1000),new Date(Date.now()+delay*60_000).toISOString(),candidate.source,candidate.sourceId]);
}

export async function getVacancy(id: number): Promise<Vacancy|null> {
  await ready(); const row=await one('select * from vacancies where id=$1',[id]); return row?rowToVacancy(row):null;
}
async function ensureUserVacancy(userId:string,vacancyId:number,client?:PoolClient):Promise<void>{
  const sql=`insert into user_vacancies(user_id,vacancy_id,source,source_id,first_relevant_at,updated_at)
    select $1,v.id,v.source,v.source_id,$3,$3 from vacancies v where v.id=$2 on conflict do nothing`;
  if(client) await client.query(sql,[userId,vacancyId,now()]); else await q(sql,[userId,vacancyId,now()]);
}
export async function pendingVacancies(userId:string,limit:number):Promise<Vacancy[]>{ await ready(); return (await q(`select v.*,uv.decision user_decision
  from vacancies v join user_vacancies uv on uv.user_id=$1 and uv.vacancy_id=v.id
  where uv.score is null and uv.decision not in ('skipped','applied') order by v.published_at desc limit $2`,[userId,limit])).map(rowToVacancy); }
export async function vacanciesNeedingPrefilter(userId:string,contextHash:string,limit:number):Promise<Vacancy[]>{
  await ready(); return (await q(`select v.*,uv.decision user_decision from vacancies v
    join user_vacancies uv on uv.user_id=$1 and uv.vacancy_id=v.id where uv.score is null and uv.decision not in ('skipped','applied')
    and (uv.prefilter_context_hash is null or uv.prefilter_context_hash<>$2 or uv.prefilter_content_hash<>v.content_hash)
    order by v.published_at desc limit $3`,[userId,contextHash,limit])).map(rowToVacancy);
}
export async function savePrefilterScore(userId:string,vacancyId:number,contextHash:string,contentHash:string,score:PrefilterScoreInput):Promise<void>{
  await ready(); await withPostgresTransaction(async client=>{ if(!await hasCv(userId,client))throw new Error('An authoritative CV source is required.');
    await ensureUserVacancy(userId,vacancyId,client); await client.query(`update user_vacancies set prefilter_context_hash=$1,
      prefilter_content_hash=$2,prefilter_regex_score=$3,prefilter_lexical_cosine=$4,prefilter_lexical_score=$5,
      prefilter_score=$6,prefilter_filtered=$7,prefilter_audit_selected=$8,prefilter_reasons=$9::jsonb,prefilter_scored_at=$10
      where user_id=$11 and vacancy_id=$12`,[contextHash,contentHash,score.regexScore,score.lexicalCosine,score.lexicalScore,
        score.combinedScore,Number(score.filtered),Number(score.auditSelected),JSON.stringify(score.reasons),now(),userId,vacancyId]); });
}
function rowsToPrefiltered(rows:Row[]):PrefilteredVacancy[]{return rows.map(row=>({...rowToVacancy(row),prefilterScore:Number(row.prefilter_score),auditSelected:Boolean(row.audit_selected)}));}
/**
 * Vacancies already accepted by the prefilter that still have no score: the ones a scoring batch was supposed to
 * cover but never completed. Unlike `rankedPendingVacancies` this ignores the prefilter context hash, so a repair
 * pass can reach rows admitted under an earlier CV/profile revision.
 */
export async function markedUnscoredVacancies(userId:string,limit:number):Promise<Vacancy[]>{
  await ready();
  return (await q(`select v.*,uv.decision user_decision from vacancies v
    join user_vacancies uv on uv.user_id=$1 and uv.vacancy_id=v.id
    where uv.score is null and uv.decision not in ('skipped','applied')
      and uv.prefilter_scored_at is not null and uv.prefilter_filtered=0
    order by uv.prefilter_score desc,v.published_at desc limit $2`,[userId,limit])).map(rowToVacancy);
}
export async function rankedPendingVacancies(userId:string,contextHash:string,limit:number,auditSlots=0):Promise<PrefilteredVacancy[]>{
  await ready(); const query=async(filtered:boolean,queryLimit:number)=>rowsToPrefiltered(await q(`select v.*,uv.decision user_decision,
    uv.prefilter_score,uv.prefilter_audit_selected audit_selected from vacancies v
    join user_vacancies uv on uv.user_id=$1 and uv.vacancy_id=v.id where uv.score is null and uv.decision not in ('skipped','applied')
    and uv.prefilter_context_hash=$2 and uv.prefilter_content_hash=v.content_hash and uv.prefilter_filtered=$3
    ${filtered?'and uv.prefilter_audit_selected<>0':''} order by uv.prefilter_score desc,v.published_at desc limit $4`,
    [userId,contextHash,Number(filtered),queryLimit]));
  const audit=await query(true,Math.min(limit,auditSlots)); return [...await query(false,Math.max(0,limit-audit.length)),...audit];
}
export async function prefilterQueueStats(userId:string,contextHash:string):Promise<{queued:number;filtered:number;auditQueued:number}>{
  await ready(); const row=await one(`select count(*) filter(where uv.prefilter_filtered=0) queued,
    count(*) filter(where uv.prefilter_filtered<>0) filtered,
    count(*) filter(where uv.prefilter_filtered<>0 and uv.prefilter_audit_selected<>0) audit_queued from user_vacancies uv
    join vacancies v on v.id=uv.vacancy_id where uv.user_id=$1 and uv.prefilter_context_hash=$2
    and uv.prefilter_content_hash=v.content_hash and uv.score is null`,[userId,contextHash]);
  return {queued:Number(row?.queued??0),filtered:Number(row?.filtered??0),auditQueued:Number(row?.audit_queued??0)};
}
export async function prefilterCalibration(userId:string,contextHash:string,alertScore:number,minimumLabels:number):Promise<PrefilterCalibration>{
  await ready(); const rows=await q(`select uv.prefilter_score combined_score,uv.prefilter_filtered filtered,
    uv.prefilter_audit_selected audit_selected,uv.score,uv.decision from user_vacancies uv join vacancies v on v.id=uv.vacancy_id
    where uv.user_id=$1 and uv.score is not null and uv.prefilter_context_hash=$2 and uv.prefilter_content_hash=v.content_hash`,[userId,contextHash]);
  const compared=rows.length;let sumX=0,sumY=0,sumXY=0,sumXX=0,sumYY=0,audited=0,auditFalseNegatives=0,applied=0,skipped=0;
  for(const row of rows){const x=Number(row.combined_score),y=Number(row.score);sumX+=x;sumY+=y;sumXY+=x*y;sumXX+=x*x;sumYY+=y*y;
    if(row.audit_selected){audited++;if(y>=alertScore)auditFalseNegatives++;}if(row.decision==='applied'||row.decision==='applying')applied++;if(row.decision==='skipped')skipped++;}
  const denominator=Math.sqrt((compared*sumXX-sumX*sumX)*(compared*sumYY-sumY*sumY));
  const correlation=compared>=2&&denominator?(compared*sumXY-sumX*sumY)/denominator:null,feedbackLabels=applied+skipped;
  return {compared,correlation,audited,auditFalseNegatives,applied,skipped,feedbackLabels,readyForAdjustment:feedbackLabels>=minimumLabels};
}

export async function saveScore(userId:string,vacancyId:number,score:number,primaryTrack:string,summary:string,reasons:string[],gaps:string[],hardRejection:boolean):Promise<void>{
  await ready(); await withPostgresTransaction(async client=>{if(!await hasCv(userId,client))throw new Error('An authoritative CV source is required.');
    await ensureUserVacancy(userId,vacancyId,client); const timestamp=now();
    const rows=await txq(client,`update user_vacancies set score=$1,score_updated_at=$2,
      updated_at=case when decision in ('alerted','digested') then $2 else updated_at end,
      decision=case when decision in ('alerted','digested') then 'new' else decision end
      where user_id=$3 and vacancy_id=$4 returning decision`,[score,timestamp,userId,vacancyId]);
    const alert=score>=config.alertScore&&!hardRejection&&String(rows[0]?.decision??'new')==='new';
    await client.query(`update user_vacancies set alert_primary_track=$1,alert_summary=$2,alert_reasons=$3::jsonb,alert_gaps=$4::jsonb
      where user_id=$5 and vacancy_id=$6`,alert
      ?[primaryTrack,summary,JSON.stringify(reasons),JSON.stringify(gaps),userId,vacancyId]
      :[null,null,null,null,userId,vacancyId]); });
}
function rowToScoredVacancy(row:Row):ScoredVacancy{return {...rowToVacancy(row),userId:String(row.score_user_id??row.user_id),score:Number(row.score)};}
function rowToAlertVacancy(row:Row):AlertVacancy{return {...rowToScoredVacancy(row),primaryTrack:String(row.primary_track),summary:String(row.summary),
  reasons:jsonValue<string[]>(row.reasons_json),gaps:jsonValue<string[]>(row.gaps_json)};}
const scoredSelect=`select v.*,uv.decision user_decision,uv.user_id score_user_id,uv.score from vacancies v
  join user_vacancies uv on uv.vacancy_id=v.id and uv.score is not null`;
export async function getScoredVacancy(userId:string,id:number):Promise<ScoredVacancy|null>{await ready();const row=await one(`${scoredSelect} where uv.user_id=$1 and v.id=$2`,[userId,id]);return row?rowToScoredVacancy(row):null;}
export async function getScoredVacancyByApplyId(userId:string,applyId:string):Promise<ScoredVacancy|null>{await ready();const row=await one(`${scoredSelect} where uv.user_id=$1 and v.apply_id=$2`,[userId,applyId]);return row?rowToScoredVacancy(row):null;}
export async function searchScoredVacancies(userId:string,input:string,limit=10):Promise<ScoredVacancy[]>{
  await ready();const tokens=input.toLowerCase().match(/[\p{L}\p{N}+#.]{2,}/gu)?.slice(0,12)??[];if(!tokens.length)return[];
  const query=tokens.join(' ');return(await q(`${scoredSelect} where uv.user_id=$1 and v.search_vector@@websearch_to_tsquery('simple',$2)
    order by ts_rank(v.search_vector,websearch_to_tsquery('simple',$2)) desc,uv.score desc limit $3`,[userId,query,Math.max(1,Math.min(limit,30))])).map(rowToScoredVacancy);
}
const currentDigest=`uv.decision='digested' and uv.updated_at=(select max(latest.updated_at) from user_vacancies latest
  where latest.user_id=uv.user_id and latest.decision='digested')`;
export async function latestDigestVacanciesByApplyIdPrefix(userId:string,prefix:string):Promise<ScoredVacancy[]>{await ready();return(await q(`${scoredSelect}
  where uv.user_id=$1 and ${currentDigest} and v.apply_id like $2
  order by uv.score desc,v.published_at desc limit 2`,[userId,`${prefix}%`])).map(rowToScoredVacancy);}
export async function currentDigestVacancies(userId:string):Promise<ScoredVacancy[]>{await ready();return(await q(`${scoredSelect}
  where uv.user_id=$1 and ${currentDigest} order by uv.score desc,v.published_at desc`,[userId])).map(rowToScoredVacancy);}
export async function digestVacancies(userId:string,min:number,high:number,since:string|null,until:string):Promise<ScoredVacancy[]>{await ready();return(await q(`${scoredSelect}
  where uv.user_id=$1 and uv.score>=$2 and uv.score<$3 and uv.decision='new' and uv.score_updated_at is not null
  and ($4::timestamptz is null or uv.score_updated_at>$4::timestamptz) and uv.score_updated_at<=$5::timestamptz
  order by uv.score desc,v.published_at desc`,[userId,min,high,since,until])).map(rowToScoredVacancy);}
export async function replaceDigestSnapshot(userId:string,ids:number[],deliveredAt:string):Promise<void>{
  await ready();const timestamp=new Date(deliveredAt);if(Number.isNaN(timestamp.getTime()))throw new Error('Digest delivery timestamp is invalid.');
  const vacancyIds=[...new Set(ids.filter(Number.isSafeInteger))];await withPostgresTransaction(async client=>{
    await client.query(`update user_vacancies set decision='new',updated_at=$1 where user_id=$2 and decision='digested'`,
      [timestamp.toISOString(),userId]);
    if(vacancyIds.length)await client.query(`update user_vacancies set decision='digested',updated_at=$1
      where user_id=$2 and vacancy_id=any($3::bigint[]) and decision='new'`,[timestamp.toISOString(),userId,vacancyIds]);
    await client.query(`update users set delivery_start_minutes=coalesce(delivery_start_minutes,0),
      delivery_end_minutes=coalesce(delivery_end_minutes,0),digest_minutes=coalesce(digest_minutes,540),
      delivery_timezone=coalesce(delivery_timezone,$1),last_digest_at=$2,updated_at=$2 where user_id=$3`,
      [config.timezone,timestamp.toISOString(),userId]);
  });
}
export async function unsentHighScoreVacancies(userId:string,minScore:number,limit=30):Promise<AlertVacancy[]>{await ready();return(await q(`select v.*,
  uv.decision user_decision,uv.user_id score_user_id,uv.score,uv.alert_primary_track primary_track,uv.alert_summary summary,
  uv.alert_reasons reasons_json,uv.alert_gaps gaps_json from vacancies v join user_vacancies uv on uv.vacancy_id=v.id and uv.score is not null
  where uv.user_id=$1 and uv.score>=$2 and uv.decision='new' and uv.alert_primary_track is not null
  order by uv.score desc,v.published_at desc limit $3`,[userId,minScore,limit])).map(rowToAlertVacancy);}
export async function markAlerted(userId:string,id:number):Promise<void>{await ready();await q(`update user_vacancies
  set decision='alerted',updated_at=$1,alert_primary_track=null,alert_summary=null,alert_reasons=null,alert_gaps=null
  where user_id=$2 and vacancy_id=$3 and decision='new'`,[now(),userId,id]);}
export async function skipVacancy(userId:string,id:number):Promise<void>{await ready();await withPostgresTransaction(async client=>{await ensureUserVacancy(userId,id,client);
  await client.query("update user_vacancies set decision='skipped',updated_at=$1 where user_id=$2 and vacancy_id=$3",[now(),userId,id]);});}
export async function beginApplication(userId:string,id:number):Promise<void>{await ready();await withPostgresTransaction(async client=>{await ensureUserVacancy(userId,id,client);const timestamp=now();
  await client.query(`update user_vacancies set decision='applying',application_status='generating',application_error=null,
    application_requested_at=coalesce(application_requested_at,$1),application_updated_at=$1,updated_at=$1 where user_id=$2 and vacancy_id=$3`,
    [timestamp,userId,id]);});}
export async function markApplicationReady(userId:string,id:number):Promise<void>{await ready();await q(`update user_vacancies set application_status='ready',
  application_updated_at=$1 where user_id=$2 and vacancy_id=$3`,[now(),userId,id]);}
export async function markApplicationDelivered(userId:string,id:number):Promise<void>{await ready();await withPostgresTransaction(async client=>{
  const timestamp=now();await client.query(`update user_vacancies set decision='applied',application_updated_at=$1,updated_at=$1
    where user_id=$2 and vacancy_id=$3`,[timestamp,userId,id]);
  await client.query(`insert into usage_events(user_id,kind,occurred_at) values($1,'application',$2)`,[userId,timestamp]);
});}
export async function failApplication(userId:string,id:number,error:string):Promise<void>{await ready();const timestamp=now();await q(`update user_vacancies
  set decision='alerted',application_status='failed',application_error=$1,application_updated_at=$2,updated_at=$2
  where user_id=$3 and vacancy_id=$4`,[error,timestamp,userId,id]);}
