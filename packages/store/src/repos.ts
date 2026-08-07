import { createHash, randomInt } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { CanonicalCvDocument, CvSourceFormat, ExtractedCvDocument } from '@jobseeker/cv/extract';
import type {
  VacancyCandidate as VacancyCandidateContract, VacancyCandidateInput, VacancyContent, VacancyInput,
} from '@jobseeker/engine/contracts';
import { careerProfilePlatformId } from '@jobseeker/engine';
import { currentStoreRuntime, storeSettings, type StoreRuntime } from './client.ts';

export type { VacancyCandidateInput, VacancyInput } from '@jobseeker/engine/contracts';


export type UserStatus = 'unregistered' | 'pending' | 'approved' | 'rejected' | 'revoked';
export interface TelegramUser {
  userId: string; chatId: string; username: string | null; displayName: string;
  status: UserStatus; isOwner: boolean; requestedAt: string | null; approvedAt: string | null;
  /** The interface language this user chose, or the client language they were first seen with. */
  locale: string | null;
}
export interface TelegramIdentity {
  userId: string; chatId: string; username?: string; displayName: string; languageCode?: string;
}
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
export interface Vacancy extends VacancyContent {
  id: number;
  applyId: string;
  decision: string;
}
export interface CvSource {
  cvSha256: string; cvText: string; document: CanonicalCvDocument;
  sourceFormat: CvSourceFormat; originalFilename: string; mediaType: string; parserName: string; parserVersion: string;
}
export interface DeliverySettings {
  startMinutes: number; endMinutes: number; digestMinutes: number; timezone: string; lastDigestAt: string | null;
}
export interface VacancyCandidate extends VacancyCandidateContract {}
export interface ScoredVacancy extends Vacancy { userId: string; score: number }
export interface AlertVacancy extends ScoredVacancy {
  primaryTrack: string; summary: string; reasons: string[]; gaps: string[];
}

import { postgresQuery, withPostgresTransaction } from './client.ts';

const safeVacancyUrl = (source: string, url: string): string => storeSettings().safeVacancyUrl(source, url);

type Row = QueryResultRow & Record<string, unknown>;
const now = (): string => new Date().toISOString();
const q = <T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> => postgresQuery<T>(text, params);
const one = async <T extends Row = Row>(text: string, params: unknown[] = []): Promise<T | undefined> => (await q<T>(text, params))[0];
const txq = async <T extends Row = Row>(client: PoolClient, text: string, params: unknown[] = []): Promise<T[]> =>
  (await client.query<T>(text, params)).rows;

// Lazy per store instance: constructing repositories never performs a database write.
const initializations = new WeakMap<StoreRuntime, Promise<void>>();
const ready = (): Promise<void> => {
  const owner = currentStoreRuntime();
  const existing = initializations.get(owner);
  if (existing) return existing;
  const created = (async () => {
    if (!storeSettings().telegramUserId) return;
    const timestamp = now();
    await q(`insert into users(user_id,chat_id,display_name,status,is_owner,approved_at,updated_at)
      values ($1,$2,'Owner','approved',1,$3,$3) on conflict(user_id) do update set chat_id=excluded.chat_id,
      status='approved',is_owner=1,approved_at=coalesce(users.approved_at,excluded.approved_at),updated_at=excluded.updated_at`,
      [storeSettings().telegramUserId, storeSettings().telegramChatId ?? storeSettings().telegramUserId, timestamp]);
  })();
  initializations.set(owner, created);
  return created;
};
function jsonValue<T>(value: unknown): T { return (typeof value === 'string' ? JSON.parse(value) : value) as T; }
function isoTimestamp(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
function optionalIsoTimestamp(value: unknown): string | null { return value == null ? null : isoTimestamp(value); }
function validTimestamp(value: unknown, fallback: string): string {
  return optionalTimestamp(value) ?? fallback;
}
function optionalTimestamp(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  const timestamp = raw ? new Date(raw) : null;
  return timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function rowToUser(row: Row): TelegramUser {
  return { userId: String(row.user_id), chatId: String(row.chat_id), username: row.username == null ? null : String(row.username),
    displayName: String(row.display_name), status: String(row.status) as TelegramUser['status'], isOwner: Boolean(row.is_owner),
    requestedAt: optionalIsoTimestamp(row.requested_at), approvedAt: optionalIsoTimestamp(row.approved_at),
    locale: row.locale == null ? null : String(row.locale) };
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
/**
 * The client language is only ever recorded for a user who has none: a Telegram client language is a first guess,
 * and it must not overwrite the language the person actually picked with /language.
 */
export async function touchTelegramUser(identity: TelegramIdentity): Promise<TelegramUser> {
  await ready(); const timestamp = now();
  const [row] = await q(`insert into users(user_id,chat_id,username,display_name,status,updated_at,locale)
    values ($1,$2,$3,$4,'unregistered',$5,$6) on conflict(user_id) do update set chat_id=excluded.chat_id,
    username=excluded.username,display_name=excluded.display_name,updated_at=excluded.updated_at,
    locale=coalesce(users.locale,excluded.locale) returning *`,
    [identity.userId, identity.chatId, identity.username ?? null, identity.displayName, timestamp,
      identity.languageCode ?? null]);
  return rowToUser(row!);
}
export async function setUserLocale(userId: string, locale: string): Promise<TelegramUser | null> {
  await ready();
  const [row] = await q('update users set locale=$1,updated_at=$2 where user_id=$3 returning *',
    [locale, now(), userId]);
  return row ? rowToUser(row) : null;
}
export async function requestAccess(identity: TelegramIdentity): Promise<AccessRequestResult> {
  const current = await touchTelegramUser(identity);
  if (current.isOwner || current.status === 'approved' || current.status === 'pending') {
    return { user: current, notifyOwner: false, retryAfterSeconds: 0 };
  }
  const remaining = (current.requestedAt ? Date.parse(current.requestedAt) : 0)
    + storeSettings().accessRequestCooldownMinutes * 60_000 - Date.now();
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
  await ready(); const cv = requireCv ? 'and exists (select 1 from cv_documents p where p.user_id=u.user_id)' : '';
  return (await q(`select u.* from users u where u.status='approved' ${cv} order by u.is_owner desc,u.user_id`)).map(rowToUser);
}
async function hasCv(userId: string, client?: PoolClient): Promise<boolean> {
  const rows = client ? await txq(client, 'select 1 from cv_documents where user_id=$1', [userId])
    : await q('select 1 from cv_documents where user_id=$1', [userId]);
  return Boolean(rows.length);
}
export async function recordUsage(userId: string, kind: UsageKind): Promise<void> {
  await ready(); if (!await hasCv(userId)) throw new Error('An authoritative CV source is required.');
  await q('insert into usage_events(user_id,kind,occurred_at) values ($1,$2,$3)', [userId, kind, now()]);
}

export interface LlmUsageInput {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
}

export async function recordLlmUsageEvent(userId: string, agent: string, model: string,
  usage: LlmUsageInput): Promise<void> {
  await ready();
  await q(`insert into usage_events(user_id,kind,occurred_at,agent,model,input_tokens,output_tokens,
    cache_read_tokens,cache_write_tokens,total_tokens,cost_usd) values($1,'llm',now(),$2,$3,$4,$5,$6,$7,$8,$9)`,
    [userId,agent,model,usage.input,usage.output,usage.cacheRead,usage.cacheWrite,usage.totalTokens,usage.costUsd]);
}
/**
 * The tailored CV and the cover letter are separate deliverables with separate daily budgets. They are told apart
 * by the agent that produced them rather than by a new usage kind, so the `usage_events` kind constraint and every
 * existing report over `kind='application'` keep working unchanged.
 */
export const applicationAgents = { cv: 'tailor-application', letter: 'tailor-cover-letter' } as const;
export type ApplicationArtifact = keyof typeof applicationAgents;

export async function usageInLast24Hours(userId: string, kind: UsageKind, agent?: string): Promise<number> {
  await ready(); const row = await one(`select count(*) count from usage_events where user_id=$1 and kind=$2
    and occurred_at>=now()-interval '1 day' and ($3::text is null or agent=$3)`, [userId, kind, agent ?? null]);
  return Number(row?.count ?? 0);
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
    for (const table of ['matches','cv_documents','usage_events','user_state','unit_subscriptions'] as const) {
      await client.query(`delete from ${table} where user_id=$1`, [userId]);
    }
    await client.query(`update search_units u set retired_at=coalesce(u.retired_at,now())
      where not exists (select 1 from unit_subscriptions s where s.unit_id=u.unit_id)`);
    // Access and identity survive; everything the person configured does not, the interface language included.
    // The next update they send re-seeds it from their Telegram client language, exactly as for a new user.
    await client.query(`update users set delivery_start_minutes=null,delivery_end_minutes=null,digest_minutes=null,
      delivery_timezone=null,last_digest_at=null,locale=null where user_id=$1`, [userId]);

  });
}
export async function exportUserData(userId: string): Promise<Record<string, unknown>> {
  await ready(); if (!await getTelegramUser(userId)) throw new Error('User was not found.');
  const [profile, scores, applications] = await Promise.all([
    one('select cv_text,document_json,search_profiles from cv_documents where user_id=$1', [userId]),
    q('select v.url,m.llm_score score from matches m join vacancies v on v.id=m.vacancy_id where m.user_id=$1 and m.llm_score is not null order by m.llm_score desc,v.url', [userId]),
    q(`select v.url,v.apply_id,m.application_artifacts from matches m join vacancies v on v.id=m.vacancy_id
      where m.user_id=$1 and m.application_artifacts<>'{}'::jsonb order by v.url`, [userId]),
  ]);
  const profiles = profile ? jsonValue<Record<string, unknown>>(profile.search_profiles) : {};
  const career = profiles[careerProfilePlatformId] as { profile?: unknown } | undefined;
  return { cvSource: profile ? String(profile.cv_text) : null, normalizedDocument: profile ? jsonValue(profile.document_json) : null,
    careerProfile: career?.profile ?? null,
    searchProfiles: Object.entries(profiles).filter(([platform]) => platform !== careerProfilePlatformId)
      .sort(([left], [right]) => left.localeCompare(right)).map(([platform, value]) => ({ platform, profile: value })),
    scores: scores.map((row) => ({ url: String(row.url), score: Number(row.score) })),
    deliveredApplicationArtifacts: applications.map((row) => ({ url: String(row.url), applyId: String(row.apply_id),
      artifacts: jsonValue<Record<string, DeliveredArtifact>>(row.application_artifacts) })) };
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
    from cv_documents where user_id=$1`, [userId]);
  return row ? { cvSha256: String(row.cv_sha256), cvText: String(row.cv_text), document: jsonValue(row.document_json),
    sourceFormat: String(row.source_format) as CvSource['sourceFormat'], originalFilename: String(row.original_filename),
    mediaType: String(row.media_type), parserName: String(row.parser_name), parserVersion: String(row.parser_version) } : null;
}
export async function getCvHash(userId: string): Promise<string | null> {
  await ready(); const row = await one('select cv_sha256 from cv_documents where user_id=$1', [userId]); return row ? String(row.cv_sha256) : null;
}
export async function saveCvSource(userId: string, originalFilename: string, cvSha256: string, extracted: ExtractedCvDocument): Promise<void> {
  await ready(); await withPostgresTransaction(async (client) => {
    await client.query(`insert into cv_documents(user_id,cv_sha256,cv_text,document_json,source_format,original_filename,media_type,parser_name,parser_version,search_profiles,updated_at)
      values($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,'{}'::jsonb,$10) on conflict(user_id) do update set cv_sha256=excluded.cv_sha256,cv_text=excluded.cv_text,
      document_json=excluded.document_json,source_format=excluded.source_format,original_filename=excluded.original_filename,
      media_type=excluded.media_type,parser_name=excluded.parser_name,parser_version=excluded.parser_version,search_profiles='{}'::jsonb,updated_at=excluded.updated_at`,
      [userId, cvSha256, extracted.text, JSON.stringify(extracted.document), extracted.sourceFormat, originalFilename,
        extracted.mediaType, extracted.parserName, extracted.parserVersion, now()]);
    // A new CV invalidates undelivered judgements; what the user already saw stays seen.
    await client.query(`update matches set state='matched',llm_score=null,score_updated_at=null,
      alert_primary_track=null,alert_summary=null,alert_reasons=null,alert_gaps=null,updated_at=$2
      where user_id=$1 and state in ('queued','scored')`, [userId, now()]);
  });
}
export async function saveSearchProfile(userId: string, platform: string, profile: unknown): Promise<void> {
  await ready(); if (!await hasCv(userId)) throw new Error('An authoritative CV source is required.');
  await q(`update cv_documents set search_profiles=jsonb_set(search_profiles,array[$2::text],$3::jsonb,true),updated_at=$4 where user_id=$1`,
    [userId, platform, JSON.stringify(profile), now()]);
}
export async function clearSearchProfile(userId: string, platform: string): Promise<void> {
  await ready(); await q('update cv_documents set search_profiles=search_profiles-$2,updated_at=$3 where user_id=$1', [userId, platform, now()]);
}
export async function getSearchProfile<T>(userId: string, platform: string): Promise<T | null> {
  await ready(); const row = await one('select search_profiles->$2 profile from cv_documents where user_id=$1', [userId, platform]);
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
    // Changed content invalidates undelivered scores; delivered matches keep their memory — the wall holds.
    if (changed) await client.query(`update matches set state='matched',llm_score=null,score_updated_at=null,
      alert_primary_track=null,alert_summary=null,alert_reasons=null,alert_gaps=null,updated_at=$2
      where vacancy_id=$1 and state in ('queued','scored')`,[normalizedId,timestamp]);
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
/**
 * Engine-world discovery: the listing lands in the shared store and nothing else. Who sees it is decided at match
 * time by every user's own vocabulary, not by whose search fetched it. Returns whether the listing is new here.
 */
export async function recordListingCandidate(raw: VacancyCandidateInput): Promise<boolean> {
  await ready(); const input = { ...raw, url: safeVacancyUrl(raw.source, raw.url) }; const timestamp = now(), summary = input.summary ?? '';
  const publishedAt = optionalTimestamp(input.publishedAt), payload = JSON.stringify(input.payload ?? null);
  const hash = createHash('sha256').update(JSON.stringify([input.title, summary, input.url, payload])).digest('hex');
  return withPostgresTransaction(async (client) => {
    const existing=(await txq(client,'select id,listing_hash from vacancies where source=$1 and source_id=$2 for update',
      [input.source,input.sourceId]))[0];
    if(!existing) await client.query(`insert into vacancies(source,source_id,url,published_at,first_seen_at,updated_at,listing_search_name,
      listing_title,listing_summary,listing_payload,listing_hash,lifecycle_status,last_seen_at) values($1,$2,$3,$4,$5,$5,$6,$7,$8,$9::jsonb,$10,'discovered',$5)`,
      [input.source,input.sourceId,input.url,publishedAt??timestamp,timestamp,input.searchName,input.title,summary,payload,hash]);
    else await client.query(`update vacancies set url=$1,listing_title=$2,listing_summary=$3,
      published_at=coalesce($4::timestamptz,published_at),listing_payload=$5::jsonb,listing_hash=$6,last_seen_at=$7,updated_at=$7 where id=$8`,
      [input.url,input.title,summary,publishedAt,payload,hash,timestamp,existing.id]);
    return !existing;
  });
}

/**
 * Retention for the shared store.
 *
 * `vacancies` is also the deduplication memory, so age alone is the wrong criterion: deleting a listing a source
 * still advertises means rediscovering it, fetching it again, paying to score it again, and delivering it to a
 * user who has already seen or skipped it. A row is therefore only dropped once the sources have stopped
 * returning it — `last_seen_at` older than the retention window — and it is old in its own right. Resurrection is
 * not free either: `recordListingCandidate` reports newness against this table, so a re-inserted row consumes one
 * of the cycle's `SEARCH_NEW_VACANCY_LIMIT` slots that a genuinely new listing should have had.
 *
 * Anything a user acted on, was already told about, or is still waiting to be delivered is kept whatever its age,
 * so a source that goes quiet for a month and comes back cannot alert anybody twice.
 */
export async function purgeExpiredVacancies(retentionDays: number, limit: number): Promise<number> {
  await ready();
  if (limit <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const deleted = await q(`delete from vacancies where id = any(select v.id from vacancies v
    where coalesce(v.last_seen_at,v.first_seen_at) < $1 and coalesce(v.published_at,v.first_seen_at) < $1
      and not exists(select 1 from matches m where m.vacancy_id=v.id
          and (m.state in ('applied','applying','skipped','alerted','digested') or m.application_status is not null
            or (m.state='scored' and m.llm_score >= $3)))
    order by coalesce(v.last_seen_at,v.first_seen_at) limit $2) returning id`,
    [cutoff, limit, storeSettings().digestMinScore]);
  return deleted.length;
}
/**
 * A prefilter score discounts the advert's age, but it is cached until the CV, the profile or the advert itself
 * changes — so without this a vacancy scored on the day it appeared would keep its fresh score for ever. A row is
 * re-scored once it crosses one of the age bands `vacancyRecency` uses, which happens at most four times in its
 * life.
 */
export interface ScraperHour { at: string; scored: number; normalized: number }
export interface SourceScrapeStats { source: string; discovered24h: number; normalized24h: number; failed: number; queued: number; closed24h: number; scored24h: number }
export interface UnitScheduleStats { platform: string; units: number; overdue: number; cadenceMin: number; cadenceMax: number; lastNoveltyAt: string | null }
export interface ScraperSummary {
  hourly: ScraperHour[];
  sources: SourceScrapeStats[];
  units: UnitScheduleStats[];
  matched24h: number; scored24h: number;
  errors: { error: string; count: number }[];
}

/** The owner's scraper/parser health view: 25 hourly points plus per-source, per-platform and error summaries. */
export async function scraperSummary(): Promise<ScraperSummary> {
  await ready();
  const hourBuckets = `with bounds as (select date_trunc('hour', now()) end_hour),
    hours as (select generate_series(end_hour - interval '24 hours', end_hour, interval '1 hour') bucket from bounds)`;
  const [hourly, sources, units, matches, errors] = await Promise.all([
    q(`${hourBuckets}
      select h.bucket,
        (select count(*) from matches m where m.score_updated_at >= h.bucket and m.score_updated_at < h.bucket + interval '1 hour') scored,
        (select count(*) from vacancies v where v.lifecycle_status in ('normalized','duplicate')
          and v.last_checked_at >= h.bucket and v.last_checked_at < h.bucket + interval '1 hour') normalized
      from hours h order by h.bucket`),
    q(`select s.source,
        count(v.id) filter (where v.first_seen_at > now() - interval '24 hours') discovered,
        count(v.id) filter (where v.lifecycle_status in ('normalized','duplicate') and v.last_checked_at > now() - interval '24 hours') normalized,
        count(v.id) filter (where v.lifecycle_status = 'failed') failed,
        count(v.id) filter (where v.lifecycle_status in ('discovered','failed')
          and (v.normalization_retry_at is null or v.normalization_retry_at <= now())) queued,
        count(v.id) filter (where v.lifecycle_status = 'closed' and v.last_checked_at > now() - interval '24 hours') closed,
        (select count(*) from matches m join vacancies mv on mv.id = m.vacancy_id
          where mv.source = s.source and m.score_updated_at > now() - interval '24 hours') scored
      from unnest($1::text[]) s(source) left join vacancies v on v.source = s.source
      group by s.source order by discovered desc, s.source`, [storeSettings().searchPlatforms]),
    q(`select platform, count(*) units, count(*) filter (where next_run_at <= now()) overdue,
        min(cadence_minutes) cadence_min, max(cadence_minutes) cadence_max, max(last_novelty_at) last_novelty_at
      from search_units where retired_at is null group by platform order by units desc`),
    one(`select count(*) filter (where matched_at > now() - interval '24 hours') matched,
        count(*) filter (where score_updated_at > now() - interval '24 hours') scored from matches`),
    q(`select left(normalization_error, 120) error, count(*) n from vacancies
      where normalization_error is not null and last_checked_at > now() - interval '24 hours'
      group by 1 order by 2 desc limit 3`),
  ]);
  return {
    hourly: hourly.map((row) => ({ at: isoTimestamp(row.bucket), scored: Number(row.scored), normalized: Number(row.normalized) })),
    sources: sources.map((row) => ({ source: String(row.source), discovered24h: Number(row.discovered),
      normalized24h: Number(row.normalized), failed: Number(row.failed), queued: Number(row.queued), closed24h: Number(row.closed), scored24h: Number(row.scored) })),
    units: units.map((row) => ({ platform: String(row.platform), units: Number(row.units), overdue: Number(row.overdue),
      cadenceMin: Number(row.cadence_min), cadenceMax: Number(row.cadence_max),
      lastNoveltyAt: row.last_novelty_at == null ? null : isoTimestamp(row.last_novelty_at) })),
    matched24h: Number(matches?.matched ?? 0), scored24h: Number(matches?.scored ?? 0),
    errors: errors.map((row) => ({ error: String(row.error), count: Number(row.n) })),
  };
}

export async function queuedListings(limit: number): Promise<VacancyCandidate[]> {
  await ready();
  const freshest = new Date(Date.now() - storeSettings().prefilterMaxAgeDays * 86_400_000).toISOString();
  return (await q(`select * from vacancies where lifecycle_status in ('discovered','failed')
    and (normalization_retry_at is null or normalization_retry_at<=$1) and source=any($3::text[])
    and published_at>=$4 order by published_at desc limit $2`,
    [now(), limit, storeSettings().searchPlatforms, freshest])).map(rowToCandidate);
}
export async function candidatesDueForRefresh(limit: number, days: number): Promise<VacancyCandidate[]> {
  await ready(); const before = new Date(Date.now()-days*86_400_000).toISOString();
  return (await q(`select * from vacancies where lifecycle_status='normalized' and (last_checked_at is null or last_checked_at<$1)
    and source=any($3::text[]) order by coalesce(last_checked_at,first_seen_at) limit $2`,
    [before,limit,storeSettings().searchPlatforms])).map(rowToCandidate);
}
export async function markCandidateNormalized(candidate: VacancyCandidate, vacancyId: number, duplicate=false): Promise<void> {
  await ready(); await withPostgresTransaction(async client=>{const timestamp=now();
    await client.query(`update vacancies set lifecycle_status=$1,normalized_vacancy_id=$2,normalization_attempts=normalization_attempts+1,
      last_checked_at=$3,normalization_error=null,normalization_retry_at=null where source=$4 and source_id=$5`,
      [duplicate?'duplicate':'normalized',vacancyId,timestamp,candidate.source,candidate.sourceId]);
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
/** A user's interaction (skip, apply) may reference a vacancy they were never matched to; the row appears then. */
async function ensureMatch(userId:string,vacancyId:number,client?:PoolClient):Promise<void>{
  const sql=`insert into matches(user_id,vacancy_id,state,matched_at,updated_at)
    values($1,$2,'matched',$3,$3) on conflict do nothing`;
  if(client) await client.query(sql,[userId,vacancyId,now()]); else await q(sql,[userId,vacancyId,now()]);
}
/** Lands a scoring result on a claimed match. Only 'queued' may become 'scored'; a lost claim writes nothing. */
export async function saveScore(userId:string,vacancyId:number,score:number,primaryTrack:string,summary:string,reasons:string[],gaps:string[],hardRejection:boolean):Promise<void>{
  await ready(); const timestamp=now();
  const alert=score>=storeSettings().alertScore&&!hardRejection;
  await q(`update matches set state='scored',llm_score=$1,score_updated_at=$2,updated_at=$2,
      alert_primary_track=$3,alert_summary=$4,alert_reasons=$5::jsonb,alert_gaps=$6::jsonb
    where user_id=$7 and vacancy_id=$8 and state='queued'`,
    alert?[score,timestamp,primaryTrack,summary,JSON.stringify(reasons),JSON.stringify(gaps),userId,vacancyId]
      :[score,timestamp,null,null,null,null,userId,vacancyId]);
}
function rowToScoredVacancy(row:Row):ScoredVacancy{return {...rowToVacancy(row),userId:String(row.score_user_id??row.user_id),score:Number(row.score)};}
function rowToAlertVacancy(row:Row):AlertVacancy{return {...rowToScoredVacancy(row),primaryTrack:String(row.primary_track),summary:String(row.summary),
  reasons:jsonValue<string[]>(row.reasons_json),gaps:jsonValue<string[]>(row.gaps_json)};}
const scoredSelect=`select v.*,m.state user_decision,m.user_id score_user_id,m.llm_score score from vacancies v
  join matches m on m.vacancy_id=v.id and m.llm_score is not null`;
export async function getScoredVacancy(userId:string,id:number):Promise<ScoredVacancy|null>{await ready();const row=await one(`${scoredSelect} where m.user_id=$1 and v.id=$2`,[userId,id]);return row?rowToScoredVacancy(row):null;}
export async function getScoredVacancyByApplyId(userId:string,applyId:string):Promise<ScoredVacancy|null>{await ready();const row=await one(`${scoredSelect} where m.user_id=$1 and v.apply_id=$2`,[userId,applyId]);return row?rowToScoredVacancy(row):null;}
export async function searchScoredVacancies(userId:string,input:string,limit=10):Promise<ScoredVacancy[]>{
  await ready();const tokens=input.toLowerCase().match(/[\p{L}\p{N}+#.]{2,}/gu)?.slice(0,12)??[];if(!tokens.length)return[];
  const query=tokens.join(' ');return(await q(`${scoredSelect} where m.user_id=$1 and v.search_vector@@websearch_to_tsquery('simple',$2)
    order by ts_rank(v.search_vector,websearch_to_tsquery('simple',$2)) desc,m.llm_score desc limit $3`,[userId,query,Math.max(1,Math.min(limit,30))])).map(rowToScoredVacancy);
}
const currentDigest=`m.state='digested' and m.updated_at=(select max(latest.updated_at) from matches latest
  where latest.user_id=m.user_id and latest.state='digested')`;
/**
 * Vacancies a digest ID can still refer to: the last delivered snapshot plus everything queued since that scheduled
 * run. `digestVacancies` lists only the queued half, but the delivered message stays in the user's chat, so its IDs
 * have to keep resolving. Expects `$1` user, `$2` minimum score, `$3` alert score.
 */
const addressableDigest=`(${currentDigest} or (m.state='scored' and m.llm_score>=$2 and m.llm_score<$3
  and m.score_updated_at is not null and ((select last_digest_at from users where user_id=$1) is null
    or m.score_updated_at>(select last_digest_at from users where user_id=$1))))`;
/**
 * Resolves an apply-id prefix everywhere the full id resolves: any scored vacancy of the user, whatever its state.
 * The digest prints the shortest prefix unique within its own set, so a wider search can collide — two rows are
 * returned so the caller can ask for more letters instead of guessing.
 */
export async function scoredVacanciesByApplyIdPrefix(userId:string,prefix:string):Promise<ScoredVacancy[]>{
  await ready();return(await q(`${scoredSelect} where m.user_id=$1 and v.apply_id like $2
  order by m.llm_score desc,v.published_at desc limit 2`,[userId,`${prefix}%`])).map(rowToScoredVacancy);}
export async function digestVacancies(userId:string,min:number,high:number,since:string|null,until:string):Promise<ScoredVacancy[]>{await ready();return(await q(`${scoredSelect}
  where m.user_id=$1 and m.llm_score>=$2 and m.llm_score<$3 and m.state='scored' and m.score_updated_at is not null
  and ($4::timestamptz is null or m.score_updated_at>$4::timestamptz) and m.score_updated_at<=$5::timestamptz
  order by m.llm_score desc,v.published_at desc`,[userId,min,high,since,until])).map(rowToScoredVacancy);}
export interface DigestPage { vacancies: ScoredVacancy[]; allApplyIds: string[]; total: number }
/** One page of everything a digest ID can still refer to — the set the pagination buttons walk. */
export async function addressableDigestPage(userId:string,min:number,high:number,pageSize:number,page:number):Promise<DigestPage>{
  await ready();
  const ids=await q(`select v.apply_id from vacancies v join matches m on m.vacancy_id=v.id and m.llm_score is not null
    where m.user_id=$1 and ${addressableDigest} order by m.llm_score desc,v.published_at desc`,[userId,min,high]);
  const rows=await q(`${scoredSelect} where m.user_id=$1 and ${addressableDigest}
    order by m.llm_score desc,v.published_at desc limit $4 offset $5`,[userId,min,high,pageSize,page*pageSize]);
  return {vacancies:rows.map(rowToScoredVacancy),allApplyIds:ids.map(row=>String(row.apply_id)),total:ids.length};
}
export async function replaceDigestSnapshot(userId:string,ids:number[],deliveredAt:string):Promise<void>{
  await ready();const timestamp=new Date(deliveredAt);if(Number.isNaN(timestamp.getTime()))throw new Error('Digest delivery timestamp is invalid.');
  const vacancyIds=[...new Set(ids.filter(Number.isSafeInteger))];await withPostgresTransaction(async client=>{
    await client.query(`update matches set state='scored',updated_at=$1 where user_id=$2 and state='digested'`,
      [timestamp.toISOString(),userId]);
    if(vacancyIds.length)await client.query(`update matches set state='digested',updated_at=$1
      where user_id=$2 and vacancy_id=any($3::bigint[]) and state='scored'`,[timestamp.toISOString(),userId,vacancyIds]);
    await client.query(`update users set delivery_start_minutes=coalesce(delivery_start_minutes,0),
      delivery_end_minutes=coalesce(delivery_end_minutes,0),digest_minutes=coalesce(digest_minutes,540),
      delivery_timezone=coalesce(delivery_timezone,$1),last_digest_at=$2,updated_at=$2 where user_id=$3`,
      [storeSettings().timezone,timestamp.toISOString(),userId]);
  });
}
export async function unsentHighScoreVacancies(userId:string,minScore:number,limit=30):Promise<AlertVacancy[]>{await ready();return(await q(`select v.*,
  m.state user_decision,m.user_id score_user_id,m.llm_score score,m.alert_primary_track primary_track,m.alert_summary summary,
  m.alert_reasons reasons_json,m.alert_gaps gaps_json from vacancies v join matches m on m.vacancy_id=v.id and m.llm_score is not null
  where m.user_id=$1 and m.llm_score>=$2 and m.state='scored' and m.alert_primary_track is not null
  order by m.llm_score desc,v.published_at desc limit $3`,[userId,minScore,limit])).map(rowToAlertVacancy);}
export async function markAlerted(userId:string,id:number):Promise<void>{await ready();await q(`update matches
  set state='alerted',updated_at=$1,alert_primary_track=null,alert_summary=null,alert_reasons=null,alert_gaps=null
  where user_id=$2 and vacancy_id=$3 and state='scored'`,[now(),userId,id]);}
export async function skipVacancy(userId:string,id:number):Promise<void>{await ready();await withPostgresTransaction(async client=>{await ensureMatch(userId,id,client);
  await client.query(`update matches set state='skipped',updated_at=$1 where user_id=$2 and vacancy_id=$3 and state<>'applied'`,[now(),userId,id]);});}
export async function beginApplication(userId:string,id:number):Promise<void>{await ready();await withPostgresTransaction(async client=>{await ensureMatch(userId,id,client);const timestamp=now();
  await client.query(`update matches set state='applying',application_status='generating',application_error=null,
    application_requested_at=coalesce(application_requested_at,$1),application_updated_at=$1,updated_at=$1 where user_id=$2 and vacancy_id=$3`,
    [timestamp,userId,id]);});}
export interface DeliveredArtifact { cvSha256: string; fileId?: string; text?: string; deliveredAt: string }
/** The artifact exactly as it went to the user, keyed to the CV it was built from; a hash mismatch means stale. */
export async function saveDeliveredArtifact(userId:string,vacancyId:number,artifact:ApplicationArtifact,
  payload:DeliveredArtifact):Promise<void>{
  await ready();await q(`update matches set application_artifacts=jsonb_set(application_artifacts,array[$4::text],$3::jsonb,true)
    where user_id=$1 and vacancy_id=$2`,[userId,vacancyId,JSON.stringify(payload),artifact]);
}
export async function deliveredArtifact(userId:string,vacancyId:number,artifact:ApplicationArtifact):Promise<DeliveredArtifact|null>{
  await ready();const row=await one(`select application_artifacts->$3 payload from matches
    where user_id=$1 and vacancy_id=$2`,[userId,vacancyId,artifact]);
  return row?.payload?jsonValue<DeliveredArtifact>(row.payload):null;
}
export async function markApplicationReady(userId:string,id:number):Promise<void>{await ready();await q(`update matches set application_status='ready',
  application_updated_at=$1 where user_id=$2 and vacancy_id=$3`,[now(),userId,id]);}
export async function markApplicationDelivered(userId:string,id:number,artifact:ApplicationArtifact):Promise<void>{
  await ready();await withPostgresTransaction(async client=>{
  const timestamp=now();await client.query(`update matches set state='applied',application_updated_at=$1,updated_at=$1
    where user_id=$2 and vacancy_id=$3`,[timestamp,userId,id]);
  await client.query(`insert into usage_events(user_id,kind,occurred_at,agent) values($1,'application',$2,$3)`,
    [userId,timestamp,applicationAgents[artifact]]);
});}
export async function failApplication(userId:string,id:number,error:string):Promise<void>{await ready();const timestamp=now();await q(`update matches
  set state='alerted',application_status='failed',application_error=$1,application_updated_at=$2,updated_at=$2
  where user_id=$3 and vacancy_id=$4 and state='applying'`,[error,timestamp,userId,id]);}
