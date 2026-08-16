import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  parseCvContentHash,
  parseCurrencyCode,
  parseSourceKey,
  parseSourceVacancyId,
  parseUserId,
  parseVacancyContentHash,
  parseVacancyListingHash,
  type CvContentHash,
  type SourceKey,
  type UserId,
  type VacancyCandidate as VacancyCandidateContract,
  type VacancyCandidateInput,
  type VacancyContent,
  type VacancyInput,
  type VacancyStatus,
} from '@jobseeker/engine/contracts';
import type { CanonicalCvDocument, CvSourceFormat, ExtractedCvDocument } from '@jobseeker/cv/extract';
import {
  postgresQuery,
  storeSettings,
  withPostgresTransaction,
} from './client.ts';

export type UserStatus = 'unregistered' | 'pending' | 'approved' | 'rejected' | 'revoked';
export type Locale = 'en' | 'ru';
export interface ScoreExplanation { readonly [key: string]: unknown }

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid ${name}: expected a positive safe integer.`);
}

function validDate(value: Date, name: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`Invalid ${name}: expected a valid Date.`);
  }
}

export interface TelegramIdentity {
  readonly userId: UserId;
  readonly username?: string;
  readonly firstName: string;
  readonly lastName?: string;
  readonly locale?: Locale;
}

export interface TelegramUser {
  readonly userId: UserId;
  readonly username: string | null;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly status: UserStatus;
  readonly isOwner: boolean;
  readonly locale: Locale | null;
  readonly localeSelected: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AccessRequestResult {
  readonly user: TelegramUser;
  readonly notifyOwner: boolean;
  readonly retryAfterSeconds: number;
}

export interface DeliverySettings {
  readonly enabled: boolean;
  readonly digestHourUtc: number;
  readonly timezone: string;
  readonly lastDigestAt: Date | null;
}

export interface CvSource {
  readonly hash: CvContentHash;
  readonly text: string;
  readonly document: CanonicalCvDocument;
  readonly format: CvSourceFormat;
  readonly originalFilename: string;
  readonly mediaType: string;
  readonly parserName: string;
  readonly parserVersion: string;
}

export class UserAccessError extends Error {
  readonly userId: UserId;

  constructor(userId: UserId) {
    super('User is not approved.');
    this.name = 'UserAccessError';
    this.userId = userId;
  }
}

interface UserRow extends QueryResultRow {
  user_id: string;
  username: string | null;
  first_name: string;
  last_name: string | null;
  status: UserStatus;
  is_owner: boolean;
  locale: Locale | null;
  locale_selected: boolean;
  status_changed_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

function dateOf(value: Date | string, name: string): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`Invalid stored ${name}: expected a timestamp.`);
  return date;
}

function userOf(row: UserRow): TelegramUser {
  return Object.freeze({
    userId: parseUserId(row.user_id),
    username: row.username,
    firstName: row.first_name,
    lastName: row.last_name,
    status: row.status,
    isOwner: row.is_owner,
    locale: row.locale,
    localeSelected: row.locale_selected,
    createdAt: dateOf(row.created_at, 'user creation time'),
    updatedAt: dateOf(row.updated_at, 'user update time'),
  });
}

async function seedOwner(client?: PoolClient): Promise<void> {
  const owner = storeSettings().telegramUserId;
  if (!owner) return;
  const query = client ? client.query.bind(client) : postgresQuery;
  // Owner approval is an invariant, not ordinary access state; no administrative action may demote it.
  await query(`insert into users(user_id,status,is_owner) values($1,'approved',true)
    on conflict(user_id) do update set status='approved',is_owner=true,status_changed_at=now(),updated_at=now()`, [owner]);
}

export async function getTelegramUser(userId: UserId): Promise<TelegramUser | null> {
  await seedOwner();
  const result = await postgresQuery<UserRow>('select * from users where user_id=$1', [userId]);
  return result.rows[0] ? userOf(result.rows[0]) : null;
}

export async function isApprovedUser(userId: UserId): Promise<boolean> {
  return (await getTelegramUser(userId))?.status === 'approved';
}

export async function requireApprovedUser(userId: UserId): Promise<TelegramUser> {
  const user = await getTelegramUser(userId);
  if (!user || user.status !== 'approved') throw new UserAccessError(userId);
  return user;
}

export async function touchTelegramUser(identity: TelegramIdentity): Promise<TelegramUser> {
  await seedOwner();
  const result = await postgresQuery<UserRow>(`insert into users(user_id,username,first_name,last_name,locale)
    values($1,$2,$3,$4,$5)
    on conflict(user_id) do update set username=excluded.username,first_name=excluded.first_name,
      last_name=excluded.last_name,
      locale=case when users.locale_selected then users.locale else coalesce(excluded.locale,users.locale) end,
      updated_at=now()
    returning *`, [
    identity.userId,
    identity.username ?? null,
    identity.firstName,
    identity.lastName ?? null,
    identity.locale ?? null,
  ]);
  return userOf(result.rows[0]!);
}

export async function setUserLocale(userId: UserId, locale: Locale): Promise<TelegramUser | null> {
  const result = await postgresQuery<UserRow>(`update users set locale=$2,locale_selected=true,updated_at=now()
    where user_id=$1 returning *`, [userId, locale]);
  return result.rows[0] ? userOf(result.rows[0]) : null;
}

export async function requestAccess(identity: TelegramIdentity): Promise<AccessRequestResult> {
  return withPostgresTransaction(async (client) => {
    await seedOwner(client);
    await client.query(`insert into users(user_id,username,first_name,last_name,locale)
      values($1,$2,$3,$4,$5) on conflict(user_id) do nothing`, [
      identity.userId, identity.username ?? null, identity.firstName, identity.lastName ?? null, identity.locale ?? null,
    ]);
    const current = (await client.query<UserRow>('select * from users where user_id=$1 for update', [identity.userId])).rows[0]!;
    if (current.is_owner || current.status === 'approved' || current.status === 'pending') {
      return Object.freeze({ user: userOf(current), notifyOwner: false, retryAfterSeconds: 0 });
    }

    const cooldownMs = storeSettings().accessRequestCooldownMinutes * 60_000;
    const changedAt = dateOf(current.status_changed_at, 'user status change time').getTime();
    const remainingMs = current.status === 'rejected' || current.status === 'revoked'
      ? Math.max(0, changedAt + cooldownMs - Date.now())
      : 0;
    if (remainingMs > 0) {
      return Object.freeze({
        user: userOf(current),
        notifyOwner: false,
        retryAfterSeconds: Math.ceil(remainingMs / 1_000),
      });
    }

    const updated = (await client.query<UserRow>(`update users set status='pending',access_requested_at=now(),
      status_changed_at=now(),updated_at=now(),username=$2,first_name=$3,last_name=$4
      where user_id=$1 returning *`, [
      identity.userId, identity.username ?? null, identity.firstName, identity.lastName ?? null,
    ])).rows[0]!;
    return Object.freeze({ user: userOf(updated), notifyOwner: true, retryAfterSeconds: 0 });
  });
}

export async function setUserStatus(
  userId: UserId,
  status: 'approved' | 'rejected' | 'revoked',
): Promise<TelegramUser | null> {
  const result = await postgresQuery<UserRow>(`update users set
      status=case when is_owner then 'approved' else $2 end,
      status_changed_at=case when is_owner then status_changed_at else now() end,
      updated_at=now()
    where user_id=$1 returning *`, [userId, status]);
  return result.rows[0] ? userOf(result.rows[0]) : null;
}

function assertPagination(limit: number, offset: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError(`Invalid user page limit: expected an integer from 1 through 100, received ${limit}.`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`Invalid user page offset: expected a nonnegative safe integer, received ${offset}.`);
  }
}

export async function listTelegramUsers(
  limit: number,
  offset: number,
): Promise<{ readonly users: readonly TelegramUser[]; readonly total: number }> {
  assertPagination(limit, offset);
  await seedOwner();
  const [users, count] = await Promise.all([
    postgresQuery<UserRow>(`select * from users order by is_owner desc,
      case status when 'pending' then 0 when 'approved' then 1 else 2 end,created_at,user_id limit $1 offset $2`, [limit, offset]),
    postgresQuery<{ total: string }>('select count(*) total from users'),
  ]);
  return Object.freeze({ users: Object.freeze(users.rows.map(userOf)), total: Number(count.rows[0]?.total ?? 0) });
}

export interface UserUsageSummary {
  readonly userId: UserId;
  readonly scores24h: number;
  readonly scoresTotal: number;
  readonly applications24h: number;
  readonly applicationsTotal: number;
}

export async function userUsageSummaries(): Promise<readonly UserUsageSummary[]> {
  const result = await postgresQuery<{ user_id: string; scores_24h: string; scores_total: string;
    applications_24h: string; applications_total: string }>(`select u.user_id,
    count(*) filter(where e.kind='score' and e.occurred_at>=now()-interval '24 hours') scores_24h,
    count(*) filter(where e.kind='score') scores_total,
    count(*) filter(where e.kind='application' and e.occurred_at>=now()-interval '24 hours') applications_24h,
    count(*) filter(where e.kind='application') applications_total
    from users u left join usage_events e on e.user_id=u.user_id group by u.user_id order by u.user_id`);
  return Object.freeze(result.rows.map((row) => Object.freeze({ userId: parseUserId(row.user_id),
    scores24h: Number(row.scores_24h), scoresTotal: Number(row.scores_total),
    applications24h: Number(row.applications_24h), applicationsTotal: Number(row.applications_total) })));
}

export async function approvedUsers(requireCv = false): Promise<readonly TelegramUser[]> {
  await seedOwner();
  const result = await postgresQuery<UserRow>(`select u.* from users u where u.status='approved'
    and ($1::boolean=false or exists(select 1 from cv_documents c where c.user_id=u.user_id))
    order by u.user_id`, [requireCv]);
  return Object.freeze(result.rows.map(userOf));
}

function assertDeliverySettings(settings: Omit<DeliverySettings, 'lastDigestAt'>): void {
  if (!Number.isSafeInteger(settings.digestHourUtc) || settings.digestHourUtc < 0 || settings.digestHourUtc > 23) {
    throw new RangeError('Invalid digest hour: expected an integer from 0 through 23.');
  }
  if (!settings.timezone.trim()) throw new TypeError('Invalid delivery timezone.');
}

export async function getDeliverySettings(userId: UserId): Promise<DeliverySettings | null> {
  const result = await postgresQuery<{ delivery_settings: unknown; last_digest_at: Date | string | null }>(
    'select delivery_settings,last_digest_at from users where user_id=$1', [userId]);
  const row = result.rows[0];
  if (!row) return null;
  const settings = row.delivery_settings as Partial<Omit<DeliverySettings, 'lastDigestAt'>>;
  if (typeof settings.enabled !== 'boolean' || typeof settings.digestHourUtc !== 'number' || typeof settings.timezone !== 'string') return null;
  return Object.freeze({
    enabled: settings.enabled,
    digestHourUtc: settings.digestHourUtc,
    timezone: settings.timezone,
    lastDigestAt: row.last_digest_at ? dateOf(row.last_digest_at, 'last digest time') : null,
  });
}

export async function saveDeliverySettings(
  userId: UserId,
  settings: Omit<DeliverySettings, 'lastDigestAt'>,
): Promise<void> {
  assertDeliverySettings(settings);
  await postgresQuery('update users set delivery_settings=$2::jsonb,updated_at=now() where user_id=$1', [
    userId, JSON.stringify(settings),
  ]);
}

interface CvRow extends QueryResultRow {
  cv_sha256: string;
  cv_text: string;
  document_json: CanonicalCvDocument;
  source_format: CvSourceFormat;
  original_filename: string;
  media_type: string;
  parser_name: string;
  parser_version: string;
}

function cvSourceOf(row: CvRow): CvSource {
  return Object.freeze({
    hash: parseCvContentHash(row.cv_sha256),
    text: row.cv_text,
    document: row.document_json,
    format: row.source_format,
    originalFilename: row.original_filename,
    mediaType: row.media_type,
    parserName: row.parser_name,
    parserVersion: row.parser_version,
  });
}

function extractedValues(userId: UserId, originalFilename: string, hash: CvContentHash, extracted: ExtractedCvDocument): unknown[] {
  return [
    userId, hash, extracted.text, JSON.stringify(extracted.document), extracted.sourceFormat,
    originalFilename, extracted.mediaType, extracted.parserName, extracted.parserVersion,
  ];
}

export async function stageCvSource(
  userId: UserId,
  originalFilename: string,
  cvSha256: CvContentHash,
  extracted: ExtractedCvDocument,
): Promise<void> {
  parseCvContentHash(cvSha256);
  await withPostgresTransaction(async (client) => {
    await client.query('delete from pending_cv_imports where expires_at<=now()');
    await client.query(`insert into pending_cv_imports(user_id,cv_sha256,cv_text,document_json,source_format,
      original_filename,media_type,parser_name,parser_version,expires_at)
      values($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,now()+interval '15 minutes')
      on conflict(user_id) do update set cv_sha256=excluded.cv_sha256,cv_text=excluded.cv_text,
        document_json=excluded.document_json,source_format=excluded.source_format,
        original_filename=excluded.original_filename,media_type=excluded.media_type,
        parser_name=excluded.parser_name,parser_version=excluded.parser_version,staged_at=now(),expires_at=excluded.expires_at`,
    extractedValues(userId, originalFilename, cvSha256, extracted));
  });
}

export async function discardStagedCvSource(userId: UserId): Promise<void> {
  await postgresQuery('delete from pending_cv_imports where user_id=$1', [userId]);
}

async function saveCvWithClient(client: PoolClient, values: readonly unknown[]): Promise<void> {
  await client.query(`insert into cv_documents(user_id,cv_sha256,cv_text,document_json,source_format,
    original_filename,media_type,parser_name,parser_version,search_profiles,career_profile)
    values($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,'{}'::jsonb,null)
    on conflict(user_id) do update set cv_sha256=excluded.cv_sha256,cv_text=excluded.cv_text,
      document_json=excluded.document_json,source_format=excluded.source_format,
      original_filename=excluded.original_filename,media_type=excluded.media_type,
      parser_name=excluded.parser_name,parser_version=excluded.parser_version,
      search_profiles='{}'::jsonb,career_profile=null,updated_at=now()`, [...values]);
  // A new CV may reconsider undelivered work, but delivered/application memory is a permanent wall.
  await client.query(`update matches set state='matched',prescore_score=null,prescore_model=null,
      prescore_prompt_version=null,prescored_at=null,prescore_exploration=false,llm_score=null,score_model=null,
      score_explanation=null,primary_track=null,short_summary=null,short_reasons=null,short_gaps=null,
      score_updated_at=null,queued_at=null,updated_at=now()
    where user_id=$1 and state in ('matched','queued','scored') and delivered_at is null`, [values[0]]);
}

export async function confirmStagedCvSource(userId: UserId): Promise<boolean> {
  return withPostgresTransaction(async (client) => {
    const row = (await client.query<CvRow>(`select * from pending_cv_imports
      where user_id=$1 and expires_at>now() for update`, [userId])).rows[0];
    if (!row) return false;
    await saveCvWithClient(client, [
      userId, row.cv_sha256, row.cv_text, JSON.stringify(row.document_json), row.source_format,
      row.original_filename, row.media_type, row.parser_name, row.parser_version,
    ]);
    await client.query('delete from pending_cv_imports where user_id=$1', [userId]);
    return true;
  });
}

export async function saveCvSource(
  userId: UserId,
  originalFilename: string,
  cvSha256: CvContentHash,
  extracted: ExtractedCvDocument,
): Promise<void> {
  parseCvContentHash(cvSha256);
  await withPostgresTransaction((client) =>
    saveCvWithClient(client, extractedValues(userId, originalFilename, cvSha256, extracted)));
}

export async function getCvSource(userId: UserId): Promise<CvSource | null> {
  const result = await postgresQuery<CvRow>('select * from cv_documents where user_id=$1', [userId]);
  return result.rows[0] ? cvSourceOf(result.rows[0]) : null;
}

export async function getCvHash(userId: UserId): Promise<CvContentHash | null> {
  const result = await postgresQuery<{ cv_sha256: string }>('select cv_sha256 from cv_documents where user_id=$1', [userId]);
  return result.rows[0] ? parseCvContentHash(result.rows[0].cv_sha256) : null;
}

export async function saveSearchProfile(userId: UserId, platform: SourceKey, profile: unknown): Promise<void> {
  parseSourceKey(platform);
  await postgresQuery(`update cv_documents set search_profiles=jsonb_set(search_profiles,array[$2],$3::jsonb,true),updated_at=now()
    where user_id=$1`, [userId, platform, JSON.stringify(profile)]);
}

export async function getSearchProfile<TResult>(userId: UserId, platform: SourceKey): Promise<TResult | null> {
  parseSourceKey(platform);
  const result = await postgresQuery<{ profile: TResult | null }>(
    'select search_profiles->$2 profile from cv_documents where user_id=$1', [userId, platform]);
  return result.rows[0]?.profile ?? null;
}

export async function clearSearchProfile(userId: UserId, platform: SourceKey): Promise<void> {
  parseSourceKey(platform);
  await postgresQuery('update cv_documents set search_profiles=search_profiles-$2,updated_at=now() where user_id=$1', [userId, platform]);
}

export async function saveCareerProfile(userId: UserId, profile: unknown): Promise<void> {
  await postgresQuery('update cv_documents set career_profile=$2::jsonb,updated_at=now() where user_id=$1', [
    userId, JSON.stringify(profile),
  ]);
}

export async function getCareerProfile<TResult>(userId: UserId): Promise<TResult | null> {
  const result = await postgresQuery<{ career_profile: TResult | null }>(
    'select career_profile from cv_documents where user_id=$1', [userId]);
  return result.rows[0]?.career_profile ?? null;
}

export async function deleteUserData(userId: UserId): Promise<void> {
  await withPostgresTransaction(async (client) => {
    for (const table of ['matches', 'pending_cv_imports', 'cv_documents', 'usage_events', 'accounts', 'user_state']) {
      await client.query(`delete from ${table} where user_id=$1`, [userId]);
    }
    await client.query('delete from unit_subscriptions where user_id=$1', [userId]);
    await client.query(`update search_units set retired_at=now(),updated_at=now()
      where retired_at is null and not exists(select 1 from unit_subscriptions s where s.unit_id=search_units.unit_id)`);
    await client.query(`update users set locale=null,locale_selected=false,delivery_settings='{}'::jsonb,
      digest_snapshot='{}',last_digest_at=null,updated_at=now() where user_id=$1`, [userId]);
  });
}

export async function exportUserData(userId: UserId): Promise<Record<string, unknown>> {
  const [user, cv, pending, scored, artifacts] = await Promise.all([
    getTelegramUser(userId),
    postgresQuery('select cv_sha256,cv_text,document_json,search_profiles,career_profile from cv_documents where user_id=$1', [userId]),
    postgresQuery(`select original_filename,cv_sha256,cv_text,document_json,expires_at from pending_cv_imports
      where user_id=$1 and expires_at>now()`, [userId]),
    postgresQuery(`select v.url,m.llm_score score from matches m join vacancies v on v.id=m.vacancy_id
      where m.user_id=$1 and m.llm_score is not null order by m.llm_score desc,v.url`, [userId]),
    postgresQuery(`select v.url,v.apply_id,m.application_artifacts from matches m join vacancies v on v.id=m.vacancy_id
      where m.user_id=$1 and m.application_artifacts<>'{}'::jsonb order by v.id`, [userId]),
  ]);
  return { user, cv: cv.rows[0] ?? null, pendingCv: pending.rows[0] ?? null, scored: scored.rows, artifacts: artifacts.rows };
}

export interface Vacancy extends VacancyContent {
  readonly id: number;
  readonly applyId: string;
  readonly lifecycleStatus: VacancyStatus;
}

export interface VacancyCandidate extends VacancyCandidateContract {}

function validUrl(source: SourceKey, url: URL): URL {
  if (!(url instanceof URL)) throw new TypeError('Invalid vacancy URL: expected URL.');
  const safe = storeSettings().safeVacancyUrl(source, url.href);
  try {
    return new URL(safe);
  } catch (error) {
    throw new TypeError('Safe vacancy URL policy returned an invalid URL.', { cause: error });
  }
}

function stableJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Invalid listing payload: numbers must be finite.');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'object') throw new TypeError(`Invalid listing payload: unsupported ${typeof value} value.`);
  if (ancestors.has(value)) throw new TypeError('Invalid listing payload: circular reference.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, ancestors)).join(',')}]`;
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('Invalid listing payload: expected plain JSON data.');
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item, ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function listingHash(input: VacancyCandidateInput, url: URL, publishedAt: Date | null): string {
  return sha256(`jobseeker.listing.v1\0${stableJson([
    input.title, input.summary ?? '', url.href, publishedAt?.toISOString() ?? null, input.payload ?? null,
  ])}`);
}

function publicationDate(value: Date | undefined, now: Date): Date | null {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()) || value > now) return null;
  return value;
}

function canonicalFingerprint(name: string, employer: string): string {
  const normalized = `${name}\0${employer}`.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return sha256(`jobseeker.vacancy-fingerprint.v1\0${normalized}`);
}

function descriptionTokens(value: string): Set<string> {
  return new Set(value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function jaccard(leftText: string, rightText: string): number {
  const left = descriptionTokens(leftText);
  const right = descriptionTokens(rightText);
  if (!left.size || !right.size) return left.size === right.size ? 1 : 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return common / (left.size + right.size - common);
}

interface VacancyRow extends QueryResultRow {
  id: string;
  source: string;
  source_id: string;
  apply_id: string;
  lifecycle_status: VacancyStatus;
  url: string;
  published_at: Date | string;
  name: string;
  employer: string;
  area: string;
  salary_json: VacancyContent['salary'];
  experience_json: VacancyContent['experience'];
  employment: VacancyContent['employment'];
  schedule: VacancyContent['schedule'];
  work_format: VacancyContent['workFormat'];
  description: string;
  key_skills_json: string[];
  source_query: string;
  content_hash: string;
}

function vacancyOf(row: VacancyRow): Vacancy {
  return Object.freeze({
    id: Number(row.id), source: parseSourceKey(row.source), sourceId: parseSourceVacancyId(row.source_id),
    applyId: row.apply_id, lifecycleStatus: row.lifecycle_status, url: new URL(row.url),
    publishedAt: new Date(row.published_at), name: row.name, employer: row.employer, area: row.area,
    salary: row.salary_json && { ...row.salary_json, currency: parseCurrencyCode(row.salary_json.currency) },
    experience: row.experience_json, employment: row.employment, schedule: row.schedule,
    workFormat: row.work_format, description: row.description, keySkills: Object.freeze(row.key_skills_json),
    sourceQuery: row.source_query,
  });
}

function candidateOf(row: QueryResultRow & Record<string, unknown>): VacancyCandidate {
  return Object.freeze({
    source: parseSourceKey(String(row.source)), sourceId: parseSourceVacancyId(String(row.source_id)),
    url: new URL(String(row.url)), searchName: String(row.listing_search_name ?? ''),
    title: String(row.listing_title ?? ''), summary: String(row.listing_summary ?? ''),
    publishedAt: new Date(row.published_at as Date | string), payload: row.listing_payload,
    listingHash: parseVacancyListingHash(String(row.listing_hash)), status: String(row.lifecycle_status) as VacancyStatus,
    attempts: Number(row.normalization_attempts), combinedScore: null,
  });
}

/** Discovery stores one shared listing row; user assignment happens later during match-on-ingest. */
export async function recordListingCandidate(raw: VacancyCandidateInput): Promise<boolean> {
  const now = new Date();
  const url = validUrl(raw.source, raw.url);
  const publishedAt = publicationDate(raw.publishedAt, now);
  const cutoff = new Date(now.getTime() - storeSettings().prefilterMaxAgeDays * 86_400_000);
  const hash = listingHash(raw, url, publishedAt);
  return withPostgresTransaction(async (client) => {
    const existing = (await client.query<{ id: string }>(
      'select id from vacancies where source=$1 and source_id=$2 for update', [raw.source, raw.sourceId])).rows[0];
    if (!existing && publishedAt && publishedAt < cutoff) return false;
    if (!existing) {
      await client.query(`insert into vacancies(source,source_id,url,published_at,first_seen_at,last_seen_at,updated_at,
        listing_search_name,listing_title,listing_summary,listing_payload,listing_hash,lifecycle_status)
        values($1,$2,$3,$4,$5,$5,$5,$6,$7,$8,$9::jsonb,$10,'discovered')`, [
        raw.source, raw.sourceId, url.href, publishedAt ?? now, now, raw.searchName, raw.title,
        raw.summary ?? '', stableJson(raw.payload ?? null), hash,
      ]);
    } else {
      await client.query(`update vacancies set url=$1,listing_title=$2,listing_summary=$3,
        published_at=coalesce($4,published_at),listing_payload=$5::jsonb,listing_hash=$6,
        last_seen_at=$7,updated_at=$7 where id=$8`, [
        url.href, raw.title, raw.summary ?? '', publishedAt, stableJson(raw.payload ?? null), hash, now, existing.id,
      ]);
    }
    return !existing;
  });
}

async function allocateApplyId(client: PoolClient): Promise<string> {
  await client.query(`select pg_advisory_xact_lock(hashtextextended('jobseeker-apply-id',0))`);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const bytes = randomBytes(6);
    const applyId = [...bytes].map((byte) => String.fromCharCode(97 + byte % 26)).join('');
    const exists = await client.query('select 1 from vacancies where apply_id=$1', [applyId]);
    if (!exists.rowCount) return applyId;
  }
  throw new Error('Unable to allocate a unique vacancy apply ID.');
}

export async function upsertVacancy(
  input: VacancyInput,
): Promise<{ readonly id: number; readonly needsScore: boolean; readonly duplicate: boolean }> {
  const now = new Date();
  const url = validUrl(input.source, input.url);
  const publishedAt = publicationDate(input.publishedAt, now) ?? now;
  const fingerprint = canonicalFingerprint(input.name, input.employer);
  const contentHash = parseVacancyContentHash(input.contentHash);
  return withPostgresTransaction(async (client) => {
    // PostgreSQL text rejects NUL separators, so length-prefix the source to keep the lock identity unambiguous.
    const vacancyLockKey = `vacancy:${input.source.length}:${input.source}:${input.sourceId}`;
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [vacancyLockKey]);
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`vacancy-fingerprint:${fingerprint}`]);
    const existing = (await client.query<{ id: string; content_hash: string | null; apply_id: string | null }>(
      'select id,content_hash,apply_id from vacancies where source=$1 and source_id=$2 for update',
      [input.source, input.sourceId])).rows[0];
    const possible = await client.query<{ id: string; description: string }>(`select id,description from vacancies
      where canonical_fingerprint=$1 and lifecycle_status='normalized'
        and not(source=$2 and source_id=$3) order by id for update`, [fingerprint, input.source, input.sourceId]);
    const duplicate = possible.rows.find((row) => jaccard(input.description, row.description) >= 0.92);
    const applyId = existing?.apply_id ?? await allocateApplyId(client);
    const values = [
      url.href, publishedAt, input.name, input.employer, input.area,
      input.salary === null ? null : JSON.stringify(input.salary),
      JSON.stringify(input.experience), input.employment, input.schedule, input.workFormat, input.description,
      JSON.stringify(input.keySkills), input.sourceQuery, contentHash, fingerprint, applyId, now,
    ];
    let ownId: number;
    if (existing) {
      ownId = Number(existing.id);
      await client.query(`update vacancies set url=$1,published_at=least(coalesce(published_at,$2),$2),name=$3,
        employer=$4,area=$5,salary_json=$6::jsonb,experience_json=$7::jsonb,employment=$8,schedule=$9,
        work_format=$10,description=$11,key_skills_json=$12::jsonb,source_query=$13,content_hash=$14,
        canonical_fingerprint=$15,apply_id=$16,updated_at=$17,last_checked_at=$17,
        lifecycle_status=$18,normalized_vacancy_id=$19 where id=$20`, [
        ...values, duplicate ? 'duplicate' : 'normalized', duplicate?.id ?? null, existing.id,
      ]);
    } else {
      const inserted = await client.query<{ id: string }>(`insert into vacancies(source,source_id,url,published_at,
        first_seen_at,last_seen_at,updated_at,name,employer,area,salary_json,experience_json,employment,schedule,
        work_format,description,key_skills_json,source_query,content_hash,canonical_fingerprint,apply_id,last_checked_at,
        lifecycle_status,normalized_vacancy_id)
        values($18,$19,$1,$2,$17,$17,$17,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$20,$21)
        returning id`, [...values, input.source, input.sourceId, duplicate ? 'duplicate' : 'normalized', duplicate?.id ?? null]);
      ownId = Number(inserted.rows[0]!.id);
    }
    if (duplicate) return Object.freeze({ id: Number(duplicate.id), needsScore: false, duplicate: true });

    const changed = !existing || existing.content_hash !== contentHash;
    if (changed && existing) {
      // Content refresh may reconsider only undelivered judgments; delivered/application memory is permanent.
      await client.query(`update matches set state='matched',prescore_score=null,prescore_model=null,
          prescore_prompt_version=null,prescored_at=null,llm_score=null,score_model=null,score_explanation=null,
          primary_track=null,short_summary=null,short_reasons=null,short_gaps=null,score_updated_at=null,updated_at=$2
        where vacancy_id=$1 and state in ('matched','queued','scored') and delivered_at is null`, [ownId, now]);
    }
    return Object.freeze({ id: ownId, needsScore: changed, duplicate: false });
  });
}

export async function queuedListings(
  limit: number,
  perSourceLimit: number,
  claimLeaseMinutes: number,
): Promise<readonly VacancyCandidate[]> {
  for (const [value, name] of [[limit, 'queue'], [perSourceLimit, 'per-source'], [claimLeaseMinutes, 'claim lease']] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) throw new RangeError(`Invalid listing ${name} limit.`);
  }
  if (perSourceLimit > limit) throw new RangeError('Invalid listing per-source limit: must not exceed queue limit.');
  return withPostgresTransaction(async (client) => {
    const result = await client.query(`with ranked as (
        select id,row_number() over(partition by source order by next_normalization_at,id) source_rank
        from vacancies where next_normalization_at<=now()
          and lifecycle_status in ('discovered','failed','normalizing'))
      select v.* from vacancies v join ranked r using(id) where r.source_rank<=$2
      order by v.next_normalization_at,v.source,v.id for update of v skip locked limit $1`, [limit, perSourceLimit]);
    if (result.rows.length) await client.query(`update vacancies set lifecycle_status='normalizing',
      normalization_attempts=normalization_attempts+1,next_normalization_at=now()+($2*interval '1 minute'),updated_at=now()
      where id=any($1::bigint[])`, [result.rows.map((row) => row.id), claimLeaseMinutes]);
    return Object.freeze(result.rows.map((row) => candidateOf({ ...row,
      lifecycle_status: 'normalizing', normalization_attempts: Number(row.normalization_attempts) + 1 })));
  });
}

export async function candidatesDueForRefresh(limit: number, days: number): Promise<readonly VacancyCandidate[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(days) || days < 1) {
    throw new RangeError('Invalid vacancy refresh bounds.');
  }
  const result = await postgresQuery(`select * from vacancies where lifecycle_status='normalized'
    and last_checked_at<=now()-($2*interval '1 day') order by last_checked_at,id limit $1`, [limit, days]);
  return Object.freeze(result.rows.map(candidateOf));
}

export async function markCandidateNormalized(candidate: VacancyCandidate, vacancyId: number, duplicate = false): Promise<void> {
  await postgresQuery(`update vacancies set lifecycle_status=$4,normalized_vacancy_id=$3,last_checked_at=now(),
    normalization_error=null,updated_at=now() where source=$1 and source_id=$2 and lifecycle_status='normalizing'`,
  [candidate.source, candidate.sourceId, vacancyId, duplicate ? 'duplicate' : 'normalized']);
}

export async function markCandidateClosed(candidate: VacancyCandidate): Promise<void> {
  await postgresQuery(`update vacancies set lifecycle_status='closed',last_checked_at=now(),updated_at=now()
    where source=$1 and source_id=$2 and lifecycle_status in ('normalizing','normalized')`, [candidate.source, candidate.sourceId]);
}

export async function markCandidateFailed(candidate: VacancyCandidate, error: string): Promise<void> {
  const bounded = error.slice(0, 500);
  await postgresQuery(`update vacancies set lifecycle_status='failed',normalization_error=$3,
      next_normalization_at=now()+(least(1440,power(2,greatest(0,normalization_attempts-1)))::text||' minutes')::interval,
      updated_at=now() where source=$1 and source_id=$2 and lifecycle_status='normalizing'`,
  [candidate.source, candidate.sourceId, bounded]);
}

export async function markCandidateRefreshFailed(candidate: VacancyCandidate, error: string): Promise<void> {
  const bounded = error.slice(0, 500);
  await postgresQuery(`update vacancies set last_checked_at=now(),normalization_error=$3,updated_at=now()
    where source=$1 and source_id=$2 and lifecycle_status='normalized'`, [candidate.source, candidate.sourceId, bounded]);
}

export async function getVacancy(id: number): Promise<Vacancy | null> {
  const result = await postgresQuery<VacancyRow>('select * from vacancies where id=$1 and lifecycle_status=\'normalized\'', [id]);
  return result.rows[0] ? vacancyOf(result.rows[0]) : null;
}

export async function purgeExpiredVacancies(retentionDays: number, limit: number): Promise<number> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('Invalid vacancy retention bounds.');
  }
  const result = await postgresQuery(`delete from vacancies where id in (
    select v.id from vacancies v where v.last_seen_at<now()-($1*interval '1 day')
      and not exists(select 1 from matches m where m.vacancy_id=v.id and (
        m.delivered_at is not null or m.application_status is not null or m.application_artifacts<>'{}'::jsonb
        or m.llm_score>=$3)) order by v.last_seen_at,v.id limit $2
    )`, [retentionDays, limit, storeSettings().digestMinScore]);
  return result.rowCount ?? 0;
}

export interface ScoredVacancy extends Vacancy {
  readonly userId: UserId;
  readonly score: number;
  readonly primaryTrack: string | null;
  readonly summary: string | null;
  readonly reasons: readonly string[];
  readonly gaps: readonly string[];
  readonly explanation: ScoreExplanation | null;
}

export interface AlertVacancy extends ScoredVacancy {}

interface ScoredRow extends VacancyRow {
  user_id: string;
  llm_score: number;
  primary_track: string | null;
  short_summary: string | null;
  short_reasons: string[] | null;
  short_gaps: string[] | null;
  score_explanation: ScoreExplanation | null;
}

function scoredOf(row: ScoredRow): ScoredVacancy {
  return Object.freeze({
    ...vacancyOf(row), userId: parseUserId(row.user_id), score: row.llm_score,
    primaryTrack: row.primary_track, summary: row.short_summary,
    reasons: Object.freeze(row.short_reasons ?? []), gaps: Object.freeze(row.short_gaps ?? []),
    explanation: row.score_explanation,
  });
}

const scoredSelect = `select v.*,m.user_id,m.llm_score,m.primary_track,m.short_summary,m.short_reasons,
  m.short_gaps,m.score_explanation from matches m join vacancies v on v.id=m.vacancy_id`;

function validApplyId(value: string, prefix = false): void {
  const pattern = prefix ? /^[a-z]{1,6}$/u : /^[a-z]{6}$/u;
  if (!pattern.test(value)) throw new TypeError(`Invalid vacancy apply ID${prefix ? ' prefix' : ''}.`);
}

export async function getScoredVacancy(targetUserId: UserId, id: number): Promise<ScoredVacancy | null> {
  positiveInteger(id, 'vacancy ID');
  const result = await postgresQuery<ScoredRow>(`${scoredSelect} where m.user_id=$1 and v.id=$2 and m.llm_score is not null`, [targetUserId, id]);
  return result.rows[0] ? scoredOf(result.rows[0]) : null;
}

export async function getScoredVacancyByApplyId(targetUserId: UserId, applyId: string): Promise<ScoredVacancy | null> {
  validApplyId(applyId);
  const result = await postgresQuery<ScoredRow>(`${scoredSelect} where m.user_id=$1 and v.apply_id=$2 and m.llm_score is not null`, [targetUserId, applyId]);
  return result.rows[0] ? scoredOf(result.rows[0]) : null;
}

export interface MatchedVacancySearchResult extends Vacancy {
  readonly score: number | null;
  readonly matchedAt: Date;
}

export async function searchMatchedVacancies(
  targetUserId: UserId, input: string, limit = 10,
): Promise<readonly MatchedVacancySearchResult[]> {
  if (!input.trim() || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RangeError('Invalid matched vacancy search.');
  const result = await postgresQuery<VacancyRow & { llm_score: number | null; matched_at: Date | string }>(`select v.*,m.llm_score,m.matched_at
    from matches m join vacancies v on v.id=m.vacancy_id cross join lateral (select websearch_to_tsquery('simple',$2) query) search
    where m.user_id=$1 and v.search_vector@@search.query
    order by ts_rank(v.search_vector,search.query) desc,m.llm_score desc nulls last,m.matched_at desc,v.id limit $3`,
  [targetUserId, input, limit]);
  return Object.freeze(result.rows.map((row) => Object.freeze({ ...vacancyOf(row), score: row.llm_score,
    matchedAt: dateOf(row.matched_at, 'match timestamp') })));
}

export async function searchScoredVacancies(
  targetUserId: UserId, input: string, limit = 10,
): Promise<readonly ScoredVacancy[]> {
  if (!input.trim() || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RangeError('Invalid scored vacancy search.');
  const result = await postgresQuery<ScoredRow>(`${scoredSelect},websearch_to_tsquery('simple',$2) query
    where m.user_id=$1 and m.llm_score is not null and v.search_vector@@query
    order by ts_rank(v.search_vector,query) desc,m.llm_score desc,v.id limit $3`, [targetUserId, input, limit]);
  return Object.freeze(result.rows.map(scoredOf));
}

export async function scoredVacancyApplyIds(targetUserId: UserId): Promise<readonly string[]> {
  const result = await postgresQuery<{ apply_id: string }>(`select v.apply_id from matches m
    join vacancies v on v.id=m.vacancy_id where m.user_id=$1 and m.llm_score is not null order by v.apply_id`, [targetUserId]);
  const applyIds = result.rows.map((row) => row.apply_id);
  for (const applyId of applyIds) validApplyId(applyId);
  return Object.freeze(applyIds);
}

export async function scoredVacanciesByApplyIdPrefix(
  targetUserId: UserId, prefix: string,
): Promise<readonly ScoredVacancy[]> {
  validApplyId(prefix, true);
  const result = await postgresQuery<ScoredRow>(`${scoredSelect} where m.user_id=$1 and v.apply_id like $2||'%'
    and m.llm_score is not null order by v.apply_id limit 2`, [targetUserId, prefix]);
  return Object.freeze(result.rows.map(scoredOf));
}

export async function digestVacancies(
  targetUserId: UserId, minimum: number, high: number, since: Date | null, until: Date,
): Promise<readonly ScoredVacancy[]> {
  validDate(until, 'digest end'); if (since) validDate(since, 'digest start');
  const result = await postgresQuery<ScoredRow>(`${scoredSelect} where m.user_id=$1 and m.state='scored'
    and m.llm_score>=$2 and m.llm_score<$3 and m.score_updated_at>$4 and m.score_updated_at<=$5
    order by m.llm_score desc,v.id`, [targetUserId, minimum, high, since ?? new Date(0), until]);
  return Object.freeze(result.rows.map(scoredOf));
}

export interface DigestPage {
  readonly vacancies: readonly ScoredVacancy[];
  readonly allApplyIds: readonly string[];
  readonly total: number;
}

export async function addressableDigestPage(
  targetUserId: UserId, minimum: number, high: number, pageSize: number, page: number,
): Promise<DigestPage> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger(page) || page < 0) {
    throw new RangeError('Invalid digest pagination.');
  }
  const ids = await postgresQuery<{ id: string; apply_id: string }>(`select distinct v.id,v.apply_id,m.llm_score
    from users u join matches m on m.user_id=u.user_id join vacancies v on v.id=m.vacancy_id
    where u.user_id=$1 and m.llm_score>=$2 and m.llm_score<$3
      and (v.id=any(u.digest_snapshot) or m.state='scored')
    order by m.llm_score desc,v.id`, [targetUserId, minimum, high]);
  const allIds = ids.rows.map((row) => Number(row.id));
  const pageIds = allIds.slice(page * pageSize, (page + 1) * pageSize);
  const rows = pageIds.length
    ? await postgresQuery<ScoredRow>(`${scoredSelect} where m.user_id=$1 and v.id=any($2::bigint[])
      order by array_position($2::bigint[],v.id)`, [targetUserId, pageIds])
    : { rows: [] as ScoredRow[] };
  return Object.freeze({
    vacancies: Object.freeze(rows.rows.map(scoredOf)),
    allApplyIds: Object.freeze(ids.rows.map((row) => row.apply_id)),
    total: allIds.length,
  });
}

export async function replaceDigestSnapshot(targetUserId: UserId, vacancyIds: readonly number[], deliveredAt: Date): Promise<void> {
  validDate(deliveredAt, 'digest delivery time');
  const unique = [...new Set(vacancyIds)];
  if (unique.length !== vacancyIds.length) throw new TypeError('Invalid digest snapshot: duplicate vacancy ID.');
  unique.forEach((id) => positiveInteger(id, 'vacancy ID'));
  await withPostgresTransaction(async (client) => {
    await client.query('select user_id from users where user_id=$1 for update', [targetUserId]);
    if (unique.length) await client.query(`update matches set state='digested',delivered_at=coalesce(delivered_at,$3),updated_at=$3
      where user_id=$1 and vacancy_id=any($2::bigint[]) and state='scored'`, [targetUserId, unique, deliveredAt]);
    await client.query('update users set digest_snapshot=$2::bigint[],last_digest_at=$3,updated_at=$3 where user_id=$1',
      [targetUserId, unique, deliveredAt]);
  });
}

export async function unsentHighScoreVacancies(
  targetUserId: UserId, minimumScore: number, limit = 30,
): Promise<readonly AlertVacancy[]> {
  const result = await postgresQuery<ScoredRow>(`${scoredSelect} where m.user_id=$1 and m.state='scored'
    and m.llm_score>=$2 and m.delivered_at is null order by m.llm_score desc,v.id limit $3`,
  [targetUserId, minimumScore, limit]);
  return Object.freeze(result.rows.map(scoredOf));
}

export async function markAlerted(targetUserId: UserId, id: number): Promise<boolean> {
  // Full score_explanation survives delivery; only short alert presentation fields are cleared.
  const result = await postgresQuery(`update matches set state='alerted',delivered_at=coalesce(delivered_at,now()),
      primary_track=null,short_summary=null,short_reasons=null,short_gaps=null,updated_at=now()
    where user_id=$1 and vacancy_id=$2 and state='scored' and delivered_at is null`, [targetUserId, id]);
  return (result.rowCount ?? 0) === 1;
}

export async function skipVacancy(targetUserId: UserId, id: number): Promise<boolean> {
  const result = await postgresQuery(`update matches set state='skipped',delivered_at=coalesce(delivered_at,now()),updated_at=now()
    where user_id=$1 and vacancy_id=$2 and state in ('scored','alerted','digested')`, [targetUserId, id]);
  return (result.rowCount ?? 0) === 1;
}

export type ApplicationArtifact = 'cv' | 'letter';

export async function beginApplication(
  targetUserId: UserId, id: number, artifact: ApplicationArtifact, cvSha256: string,
): Promise<boolean> {
  parseCvContentHash(cvSha256);
  const result = await postgresQuery(`update matches set state='applying',application_status='generating',
      application_error=null,application_started_at=now(),updated_at=now()
    where user_id=$1 and vacancy_id=$2 and state in ('alerted','digested','skipped','applied')
      and application_status is null
      and (application_artifacts->$3 is null or application_artifacts->$3->>'cvSha256' is distinct from $4)`,
  [targetUserId, id, artifact, cvSha256]);
  return (result.rowCount ?? 0) === 1;
}

export const applicationAgents = { cv: 'tailor-application', letter: 'tailor-cover-letter' } as const;

export interface DeliveredArtifact {
  readonly cvSha256: string;
  readonly fileId?: string;
  readonly text?: string;
  readonly deliveredAt: Date;
}

function validArtifact(value: Omit<DeliveredArtifact, 'deliveredAt'>): void {
  parseCvContentHash(value.cvSha256);
  if ((value.fileId === undefined) === (value.text === undefined)) {
    throw new TypeError('Invalid delivered artifact: expected exactly one of fileId or text.');
  }
}

export async function saveDeliveredArtifact(
  targetUserId: UserId, vacancyId: number, artifact: ApplicationArtifact,
  value: Omit<DeliveredArtifact, 'deliveredAt'>, deliveredAt: Date,
): Promise<boolean> {
  validArtifact(value); validDate(deliveredAt, 'artifact delivery time');
  const snapshot = { ...value, deliveredAt: deliveredAt.toISOString() };
  const result = await postgresQuery(`update matches set application_artifacts=jsonb_set(application_artifacts,array[$3],$4::jsonb,true),
    updated_at=$5 where user_id=$1 and vacancy_id=$2`, [targetUserId, vacancyId, artifact, JSON.stringify(snapshot), deliveredAt]);
  return (result.rowCount ?? 0) === 1;
}

export async function deliveredArtifact(
  targetUserId: UserId, vacancyId: number, artifact: ApplicationArtifact,
): Promise<DeliveredArtifact | null> {
  const result = await postgresQuery<{ artifact: { cvSha256: string; fileId?: string; text?: string; deliveredAt: string } | null }>(
    'select application_artifacts->$3 artifact from matches where user_id=$1 and vacancy_id=$2',
    [targetUserId, vacancyId, artifact]);
  const value = result.rows[0]?.artifact;
  return value ? Object.freeze({ ...value, deliveredAt: new Date(value.deliveredAt) }) : null;
}

export async function markApplicationReady(targetUserId: UserId, id: number): Promise<boolean> {
  const result = await postgresQuery(`update matches set application_status='ready',application_ready_at=now(),updated_at=now()
    where user_id=$1 and vacancy_id=$2 and state='applying' and application_status='generating'`, [targetUserId, id]);
  return (result.rowCount ?? 0) === 1;
}

export async function failApplication(targetUserId: UserId, id: number, error: string): Promise<boolean> {
  const result = await postgresQuery(`update matches set application_status='failed',application_error=$3,
      state=case when delivered_at is not null then 'alerted' else 'skipped' end,updated_at=now()
    where user_id=$1 and vacancy_id=$2 and state='applying' and application_status='generating'`,
  [targetUserId, id, error.slice(0, 500)]);
  return (result.rowCount ?? 0) === 1;
}

export async function markApplicationDelivered(
  targetUserId: UserId, id: number, artifact: ApplicationArtifact,
): Promise<boolean> {
  return withPostgresTransaction(async (client) => {
    const updated = await client.query(`update matches set state='applied',application_status=null,
        application_delivered_at=now(),delivered_at=coalesce(delivered_at,now()),updated_at=now()
      where user_id=$1 and vacancy_id=$2 and state='applying' and application_status='ready' returning vacancy_id`,
    [targetUserId, id]);
    if (!updated.rowCount) return false;
    await client.query(`insert into usage_events(user_id,kind,agent,occurred_at)
      values($1,'application',$2,now())`, [targetUserId, applicationAgents[artifact]]);
    return true;
  });
}

export type UsageKind = 'score' | 'application' | 'search-profile';

export async function recordUsage(targetUserId: UserId, kind: UsageKind, agent?: string): Promise<void> {
  await postgresQuery('insert into usage_events(user_id,kind,agent) values($1,$2,$3)', [targetUserId, kind, agent ?? null]);
}

export interface LlmUsageInput {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

export async function recordLlmUsageEvent(
  targetUserId: UserId, agent: string, model: string, usage: LlmUsageInput,
): Promise<void> {
  for (const [name, value] of Object.entries(usage)) {
    if (!Number.isFinite(value) || value < 0 || (name !== 'costUsd' && !Number.isSafeInteger(value))) {
      throw new RangeError(`Invalid LLM usage ${name}.`);
    }
  }
  await postgresQuery(`insert into usage_events(user_id,kind,agent,model,input_tokens,output_tokens,
    cache_read_tokens,cache_write_tokens,total_tokens,cost_usd)
    values($1,'llm',$2,$3,$4,$5,$6,$7,$8,$9)`, [
    targetUserId, agent, model, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens,
    usage.cacheWriteTokens, usage.totalTokens, usage.costUsd,
  ]);
}

export async function usageInLast24Hours(targetUserId: UserId, kind: UsageKind, agent?: string): Promise<number> {
  const result = await postgresQuery<{ total: string }>(`select count(*) total from usage_events
    where user_id=$1 and kind=$2 and occurred_at>=now()-interval '24 hours'
      and ($3::text is null or agent=$3)`, [targetUserId, kind, agent ?? null]);
  return Number(result.rows[0]?.total ?? 0);
}

export interface UsageHour { readonly at: Date; readonly tokens: number; readonly costUsd: number }
export interface LlmUsageSummary {
  readonly turns24h: number; readonly turnsTotal: number; readonly tokens24h: number; readonly tokensTotal: number;
  readonly inputTokens24h: number; readonly inputTokensTotal: number;
  readonly outputTokens24h: number; readonly outputTokensTotal: number;
  readonly cacheReadTokens24h: number; readonly cacheReadTokensTotal: number;
  readonly cacheWriteTokens24h: number; readonly cacheWriteTokensTotal: number;
  readonly cost24h: number; readonly costTotal: number; readonly hours: readonly UsageHour[];
}

export async function llmUsageSummary(): Promise<LlmUsageSummary> {
  const totals = await postgresQuery<Record<string, string>>(`select
    count(*) filter(where kind='llm' and occurred_at>=now()-interval '24 hours') turns_24h,
    count(*) filter(where kind='llm') turns_total,
    coalesce(sum(total_tokens) filter(where kind='llm' and occurred_at>=now()-interval '24 hours'),0) tokens_24h,
    coalesce(sum(total_tokens) filter(where kind='llm'),0) tokens_total,
    coalesce(sum(input_tokens) filter(where kind='llm' and occurred_at>=now()-interval '24 hours'),0) input_tokens_24h,
    coalesce(sum(input_tokens) filter(where kind='llm'),0) input_tokens_total,
    coalesce(sum(output_tokens) filter(where kind='llm' and occurred_at>=now()-interval '24 hours'),0) output_tokens_24h,
    coalesce(sum(output_tokens) filter(where kind='llm'),0) output_tokens_total,
    coalesce(sum(cache_read_tokens) filter(where kind='llm' and occurred_at>=now()-interval '24 hours'),0) cache_read_tokens_24h,
    coalesce(sum(cache_read_tokens) filter(where kind='llm'),0) cache_read_tokens_total,
    coalesce(sum(cache_write_tokens) filter(where kind='llm' and occurred_at>=now()-interval '24 hours'),0) cache_write_tokens_24h,
    coalesce(sum(cache_write_tokens) filter(where kind='llm'),0) cache_write_tokens_total,
    coalesce(sum(cost_usd) filter(where kind='llm' and occurred_at>=now()-interval '24 hours'),0) cost_24h,
    coalesce(sum(cost_usd) filter(where kind='llm'),0) cost_total from usage_events`);
  const hours = await postgresQuery<{ at: Date | string; tokens: string; cost_usd: string }>(`with hours as (
    select generate_series(date_trunc('hour',now())-interval '24 hours',date_trunc('hour',now()),interval '1 hour') at)
    select h.at,coalesce(sum(e.total_tokens),0) tokens,coalesce(sum(e.cost_usd),0) cost_usd from hours h
    left join usage_events e on e.kind='llm' and e.occurred_at>=h.at and e.occurred_at<h.at+interval '1 hour'
    group by h.at order by h.at`);
  const total = totals.rows[0]!;
  return Object.freeze({
    turns24h: Number(total.turns_24h), turnsTotal: Number(total.turns_total), tokens24h: Number(total.tokens_24h),
    tokensTotal: Number(total.tokens_total), inputTokens24h: Number(total.input_tokens_24h), inputTokensTotal: Number(total.input_tokens_total),
    outputTokens24h: Number(total.output_tokens_24h), outputTokensTotal: Number(total.output_tokens_total),
    cacheReadTokens24h: Number(total.cache_read_tokens_24h), cacheReadTokensTotal: Number(total.cache_read_tokens_total),
    cacheWriteTokens24h: Number(total.cache_write_tokens_24h), cacheWriteTokensTotal: Number(total.cache_write_tokens_total),
    cost24h: Number(total.cost_24h), costTotal: Number(total.cost_total),
    hours: Object.freeze(hours.rows.map((row) => Object.freeze({ at: new Date(row.at), tokens: Number(row.tokens), costUsd: Number(row.cost_usd) }))),
  });
}

export interface SourceScrapeStats {
  readonly source: string; readonly discovered24h: number; readonly normalized24h: number;
  readonly failed: number; readonly queued: number; readonly closed24h: number; readonly scored24h: number;
}
export interface UnitScheduleStats {
  readonly platform: string; readonly units: number; readonly overdue: number;
  readonly cadenceMin: number; readonly cadenceMax: number; readonly lastNoveltyAt: Date | null;
}
export interface NormalizationQueueStats {
  readonly queued: number; readonly activeClaims: number; readonly expiredClaims: number;
}
export interface ScraperSummary {
  readonly hours: readonly { readonly at: Date; readonly normalized: number; readonly scored: number }[];
  readonly sources: readonly SourceScrapeStats[];
  readonly units: readonly UnitScheduleStats[];
  readonly normalization: NormalizationQueueStats;
  readonly matched24h: number;
  readonly scored24h: number;
  readonly parserErrors: readonly { readonly error: string; readonly count: number }[];
}

export async function scraperSummary(): Promise<ScraperSummary> {
  const platforms = storeSettings().searchPlatforms;
  const [hours, sources, units, normalization, counts, errors] = await Promise.all([
    postgresQuery<{ at: Date | string; normalized: string; scored: string }>(`with hours as (
      select generate_series(date_trunc('hour',now())-interval '24 hours',date_trunc('hour',now()),interval '1 hour') at)
      select h.at,count(distinct v.id) filter(where v.last_checked_at>=h.at and v.last_checked_at<h.at+interval '1 hour') normalized,
        count(distinct m.vacancy_id) filter(where m.score_updated_at>=h.at and m.score_updated_at<h.at+interval '1 hour') scored
      from hours h left join vacancies v on true left join matches m on m.vacancy_id=v.id group by h.at order by h.at`),
    postgresQuery<{ source: string; discovered_24h: string; normalized_24h: string; failed: string; queued: string;
      closed_24h: string; scored_24h: string }>(`with configured(source) as (select unnest($1::text[])) select c.source,
      count(v.id) filter(where v.first_seen_at>=now()-interval '24 hours') discovered_24h,
      count(v.id) filter(where v.lifecycle_status in ('normalized','duplicate') and v.last_checked_at>=now()-interval '24 hours') normalized_24h,
      count(v.id) filter(where v.lifecycle_status='failed') failed,
      count(v.id) filter(where v.lifecycle_status in ('discovered','failed') and v.next_normalization_at<=now()) queued,
      count(v.id) filter(where v.lifecycle_status='closed' and v.last_checked_at>=now()-interval '24 hours') closed_24h,
      (select count(*) from matches m join vacancies scored_v on scored_v.id=m.vacancy_id
        where scored_v.source=c.source and m.score_updated_at>=now()-interval '24 hours') scored_24h
      from configured c left join vacancies v on v.source=c.source group by c.source order by discovered_24h desc,c.source`, [platforms]),
    postgresQuery<{ platform: string; units: string; overdue: string; cadence_min: number; cadence_max: number;
      last_novelty_at: Date | string | null }>(`select platform,count(*) units,count(*) filter(where next_run_at<=now()) overdue,
      min(cadence_minutes) cadence_min,max(cadence_minutes) cadence_max,max(last_novelty_at) last_novelty_at
      from search_units where retired_at is null group by platform order by platform`),
    postgresQuery<{ queued: string; active_claims: string; expired_claims: string }>(`select
      count(*) filter(where lifecycle_status in ('discovered','failed') and next_normalization_at<=now()) queued,
      count(*) filter(where lifecycle_status='normalizing' and next_normalization_at>now()) active_claims,
      count(*) filter(where lifecycle_status='normalizing' and next_normalization_at<=now()) expired_claims
      from vacancies`),
    postgresQuery<{ matched: string; scored: string }>(`select
      count(*) filter(where matched_at>=now()-interval '24 hours') matched,
      count(*) filter(where score_updated_at>=now()-interval '24 hours') scored from matches`),
    postgresQuery<{ error: string; count: string }>(`select left(normalization_error,120) error,count(*) count from vacancies
      where normalization_error is not null and last_checked_at>=now()-interval '24 hours'
      group by left(normalization_error,120) order by count(*) desc,error limit 3`),
  ]);
  return Object.freeze({
    hours: Object.freeze(hours.rows.map((row) => Object.freeze({ at: new Date(row.at), normalized: Number(row.normalized), scored: Number(row.scored) }))),
    sources: Object.freeze(sources.rows.map((row) => Object.freeze({ source: row.source,
      discovered24h: Number(row.discovered_24h), normalized24h: Number(row.normalized_24h), failed: Number(row.failed),
      queued: Number(row.queued), closed24h: Number(row.closed_24h), scored24h: Number(row.scored_24h) }))),
    units: Object.freeze(units.rows.map((row) => Object.freeze({ platform: row.platform, units: Number(row.units),
      overdue: Number(row.overdue), cadenceMin: Number(row.cadence_min), cadenceMax: Number(row.cadence_max),
      lastNoveltyAt: row.last_novelty_at == null ? null : new Date(row.last_novelty_at) }))),
    normalization: Object.freeze({ queued: Number(normalization.rows[0]?.queued ?? 0),
      activeClaims: Number(normalization.rows[0]?.active_claims ?? 0), expiredClaims: Number(normalization.rows[0]?.expired_claims ?? 0) }),
    matched24h: Number(counts.rows[0]?.matched ?? 0), scored24h: Number(counts.rows[0]?.scored ?? 0),
    parserErrors: Object.freeze(errors.rows.map((row) => Object.freeze({ error: row.error, count: Number(row.count) }))),
  });
}
