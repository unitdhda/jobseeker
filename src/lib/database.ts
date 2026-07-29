import { createHash, randomInt } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import type { CanonicalCvDocument, CvSourceFormat, ExtractedCvDocument } from './cv-adapters.ts';
import { safeVacancyUrl } from './url-security.ts';

process.umask(0o077);
mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
chmodSync(dirname(config.databasePath), 0o700);
export const db = new DatabaseSync(config.databasePath);
chmodSync(config.databasePath, 0o600);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const ownerId = config.telegramUserId;
const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const columns = (table: string): string[] => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
const tableSql = (table: string): string => String(db.prepare(
  "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
).get(table)?.sql ?? '');
const tableExists = (table: string): boolean => Boolean(tableSql(table));

// Users are created first so legacy single-user data can be assigned to the configured owner.
db.exec(`
CREATE TABLE IF NOT EXISTS telegram_users (
  user_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  username TEXT,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unregistered','pending','approved','rejected','revoked')),
  is_owner INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT,
  approved_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_users_chat_idx ON telegram_users(chat_id);
CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
`);

if (ownerId) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO telegram_users
    (user_id,chat_id,display_name,status,is_owner,approved_at,updated_at) VALUES (?,?,?,'approved',1,?,?)
    ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id,status='approved',is_owner=1,
      approved_at=COALESCE(telegram_users.approved_at,excluded.approved_at),updated_at=excluded.updated_at`)
    .run(ownerId, config.telegramChatId ?? ownerId, 'Owner', now, now);
}

const legacyMultiuser = !db.prepare("SELECT 1 FROM app_migrations WHERE name='multiuser-v1'").get()
  && ['cv_templates', 'search_profiles', 'scores', 'prefilter_scores', 'embedding_cache', 'applications']
    .some((table) => tableExists(table) && !columns(table).includes('user_id'));
if (legacyMultiuser && !ownerId) {
  throw new Error('TELEGRAM_USER_ID is required to assign existing single-user data to the owner.');
}

// New installations get the multi-user schema directly. Existing tables are rebuilt below.
db.exec(`
CREATE TABLE IF NOT EXISTS cv_templates (
  user_id TEXT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK (language IN ('ru','en')),
  cv_sha256 TEXT NOT NULL,
  cv_text TEXT NOT NULL,
  document_json TEXT NOT NULL,
  source_format TEXT NOT NULL CHECK (source_format IN ('pdf','md','txt','doc','docx')),
  original_filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  parser_name TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id,language)
);
CREATE TABLE IF NOT EXISTS search_profiles (
  user_id TEXT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id,platform)
);
CREATE TABLE IF NOT EXISTS global_scheduler_settings (
  name TEXT PRIMARY KEY CHECK (name IN ('scrape','notify','digest')),
  cron TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_delivery_windows (
  user_id TEXT PRIMARY KEY REFERENCES telegram_users(user_id) ON DELETE CASCADE,
  start_minutes INTEGER NOT NULL CHECK (start_minutes BETWEEN 0 AND 1439),
  end_minutes INTEGER NOT NULL CHECK (end_minutes BETWEEN 0 AND 1439),
  timezone TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_deliveries (
  user_id TEXT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('notify','digest')),
  queued_at TEXT NOT NULL,
  PRIMARY KEY (user_id,kind)
);
CREATE TABLE IF NOT EXISTS vacancies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hh_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  apply_id TEXT NOT NULL CHECK(length(apply_id)=6 AND apply_id NOT GLOB '*[^a-z]*'),
  name TEXT NOT NULL,
  employer TEXT NOT NULL,
  area TEXT NOT NULL,
  salary_from INTEGER,
  salary_to INTEGER,
  salary_currency TEXT,
  salary_gross INTEGER,
  experience TEXT NOT NULL,
  employment TEXT NOT NULL,
  schedule TEXT NOT NULL,
  work_format TEXT NOT NULL,
  description TEXT NOT NULL,
  key_skills_json TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at TEXT NOT NULL,
  source_query TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  canonical_fingerprint TEXT,
  decision TEXT NOT NULL DEFAULT 'new' CHECK (decision IN ('new','alerted','digested','skipped','applying','applied')),
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_vacancies (
  user_id TEXT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
  vacancy_id INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
  decision TEXT NOT NULL DEFAULT 'new' CHECK (decision IN ('new','alerted','digested','skipped','applying','applied')),
  first_relevant_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id,vacancy_id)
);
CREATE TABLE IF NOT EXISTS scores (
  user_id TEXT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
  vacancy_id INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  primary_track TEXT NOT NULL CHECK (length(trim(primary_track)) BETWEEN 1 AND 80),
  summary TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  gaps_json TEXT NOT NULL,
  hard_rejection INTEGER NOT NULL DEFAULT 0,
  scored_at TEXT NOT NULL,
  alert_sent_at TEXT,
  digest_sent_at TEXT,
  PRIMARY KEY (user_id,vacancy_id)
);
CREATE TABLE IF NOT EXISTS prefilter_scores (
  user_id TEXT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
  vacancy_id INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
  context_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  regex_score INTEGER NOT NULL CHECK (regex_score BETWEEN 0 AND 100),
  embedding_cosine REAL NOT NULL,
  embedding_score INTEGER NOT NULL CHECK (embedding_score BETWEEN 0 AND 100),
  semantic_cosine REAL,
  semantic_score INTEGER,
  semantic_status TEXT NOT NULL DEFAULT 'disabled' CHECK (semantic_status IN ('ready','skipped','disabled','unavailable')),
  combined_score INTEGER NOT NULL CHECK (combined_score BETWEEN 0 AND 100),
  filtered INTEGER NOT NULL,
  audit_selected INTEGER NOT NULL DEFAULT 0,
  reasons_json TEXT NOT NULL,
  scored_at TEXT NOT NULL,
  PRIMARY KEY (user_id,vacancy_id)
);
CREATE TABLE IF NOT EXISTS embedding_cache (
  model TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cv','vacancy')),
  user_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((kind='vacancy' AND user_id='') OR (kind='cv' AND length(user_id)>0)),
  PRIMARY KEY (model,kind,user_id,content_hash)
);
CREATE TABLE IF NOT EXISTS vacancy_candidates (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  search_name TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  published_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  listing_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('discovered','queued','filtered','normalizing','normalized','duplicate','failed','closed')),
  vacancy_id INTEGER REFERENCES vacancies(id) ON DELETE SET NULL,
  prefilter_context_hash TEXT,
  regex_score INTEGER,
  lexical_cosine REAL,
  semantic_cosine REAL,
  semantic_status TEXT NOT NULL DEFAULT 'disabled' CHECK (semantic_status IN ('ready','skipped','disabled','unavailable')),
  combined_score INTEGER,
  filter_reasons_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_checked_at TEXT,
  PRIMARY KEY (source,source_id)
);
CREATE TABLE IF NOT EXISTS candidate_discoveries (
  user_id TEXT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  search_name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id,source,source_id),
  FOREIGN KEY (source,source_id) REFERENCES vacancy_candidates(source,source_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS applications (
  user_id TEXT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
  vacancy_id INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('generating','ready','failed')),
  error TEXT,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id,vacancy_id)
);
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('score','application','search-profile')),
  occurred_at TEXT NOT NULL
);
`);

if (legacyMultiuser) {
  const owner = sqlString(ownerId!);
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec('BEGIN');
  try {
    if (tableExists('cv_templates') && !columns('cv_templates').includes('user_id')) {
      db.exec(`ALTER TABLE cv_templates RENAME TO cv_templates_single_user;
        CREATE TABLE cv_templates (
          user_id TEXT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
          language TEXT NOT NULL CHECK (language IN ('ru','en')),cv_sha256 TEXT NOT NULL,cv_text TEXT NOT NULL,
          document_json TEXT NOT NULL,source_format TEXT NOT NULL CHECK (source_format IN ('pdf','md','txt','doc','docx')),
          original_filename TEXT NOT NULL,media_type TEXT NOT NULL,parser_name TEXT NOT NULL,parser_version TEXT NOT NULL,
          updated_at TEXT NOT NULL,PRIMARY KEY (user_id,language));
        INSERT INTO cv_templates SELECT ${owner},language,cv_sha256,cv_text,
          json_object('version',1,'blocks',json_array(json_object('type','paragraph','text',cv_text))),
          'pdf',language||'.pdf','application/pdf','legacy-unpdf','1',updated_at FROM cv_templates_single_user;
        DROP TABLE cv_templates_single_user;`);
    }
    if (tableExists('search_profiles') && !columns('search_profiles').includes('user_id')) {
      db.exec(`ALTER TABLE search_profiles RENAME TO search_profiles_single_user;
        CREATE TABLE search_profiles (
          user_id TEXT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
          platform TEXT NOT NULL, profile_json TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id,platform));
        INSERT INTO search_profiles SELECT ${owner},platform,profile_json,updated_at FROM search_profiles_single_user;
        DROP TABLE search_profiles_single_user;`);
    }
    if (tableExists('scores') && !columns('scores').includes('user_id')) {
      db.exec(`DROP INDEX IF EXISTS scores_score_idx;
        ALTER TABLE scores RENAME TO scores_single_user;
        CREATE TABLE scores (
          user_id TEXT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
          vacancy_id INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
          score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
          primary_track TEXT NOT NULL CHECK (length(trim(primary_track)) BETWEEN 1 AND 80),
          summary TEXT NOT NULL,reasons_json TEXT NOT NULL,gaps_json TEXT NOT NULL,
          hard_rejection INTEGER NOT NULL DEFAULT 0,scored_at TEXT NOT NULL,alert_sent_at TEXT,digest_sent_at TEXT,
          PRIMARY KEY (user_id,vacancy_id));
        INSERT INTO scores SELECT ${owner},vacancy_id,score,primary_track,summary,reasons_json,gaps_json,
          hard_rejection,scored_at,alert_sent_at,digest_sent_at FROM scores_single_user;
        DROP TABLE scores_single_user;`);
    }
    if (tableExists('prefilter_scores') && !columns('prefilter_scores').includes('user_id')) {
      db.exec(`DROP INDEX IF EXISTS prefilter_queue_idx;
        ALTER TABLE prefilter_scores RENAME TO prefilter_scores_single_user;
        CREATE TABLE prefilter_scores (
          user_id TEXT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
          vacancy_id INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
          context_hash TEXT NOT NULL,content_hash TEXT NOT NULL,
          regex_score INTEGER NOT NULL CHECK (regex_score BETWEEN 0 AND 100),embedding_cosine REAL NOT NULL,
          embedding_score INTEGER NOT NULL CHECK (embedding_score BETWEEN 0 AND 100),semantic_cosine REAL,semantic_score INTEGER,
          semantic_status TEXT NOT NULL DEFAULT 'disabled' CHECK (semantic_status IN ('ready','skipped','disabled','unavailable')),
          combined_score INTEGER NOT NULL CHECK (combined_score BETWEEN 0 AND 100),filtered INTEGER NOT NULL,
          audit_selected INTEGER NOT NULL DEFAULT 0,reasons_json TEXT NOT NULL,scored_at TEXT NOT NULL,
          PRIMARY KEY (user_id,vacancy_id));
        INSERT INTO prefilter_scores SELECT ${owner},vacancy_id,context_hash,content_hash,regex_score,embedding_cosine,
          embedding_score,semantic_cosine,semantic_score,semantic_status,combined_score,filtered,audit_selected,reasons_json,scored_at
          FROM prefilter_scores_single_user;
        DROP TABLE prefilter_scores_single_user;`);
    }
    if (tableExists('embedding_cache') && !columns('embedding_cache').includes('user_id')) {
      db.exec(`ALTER TABLE embedding_cache RENAME TO embedding_cache_single_user;
        CREATE TABLE embedding_cache (
          model TEXT NOT NULL,kind TEXT NOT NULL CHECK (kind IN ('cv','vacancy')),user_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,dimensions INTEGER NOT NULL,vector BLOB NOT NULL,created_at TEXT NOT NULL,
          CHECK ((kind='vacancy' AND user_id='') OR (kind='cv' AND length(user_id)>0)),
          PRIMARY KEY (model,kind,user_id,content_hash));
        INSERT INTO embedding_cache SELECT model,kind,CASE WHEN kind='cv' THEN ${owner} ELSE '' END,
          content_hash,dimensions,vector,created_at FROM embedding_cache_single_user;
        DROP TABLE embedding_cache_single_user;`);
    }
    if (tableExists('applications') && !columns('applications').includes('user_id')) {
      const legacyApplicationColumns = columns('applications');
      db.exec(`ALTER TABLE applications RENAME TO applications_single_user;
        CREATE TABLE applications (
          user_id TEXT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
          vacancy_id INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('generating','ready','failed')),error TEXT,
          requested_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY (user_id,vacancy_id));
        INSERT INTO applications (user_id,vacancy_id,status,error,requested_at,updated_at)
          SELECT ${owner},vacancy_id,status,error,requested_at,updated_at FROM applications_single_user;
        DROP TABLE applications_single_user;`);
      void legacyApplicationColumns;
    }
    if (tableExists('scheduler_settings')) {
      db.exec(`INSERT OR IGNORE INTO global_scheduler_settings(name,cron,updated_at)
          SELECT 'scrape',cron,updated_at FROM scheduler_settings WHERE name='notify';
        INSERT OR IGNORE INTO global_scheduler_settings(name,cron,updated_at)
          SELECT name,cron,updated_at FROM scheduler_settings WHERE name IN ('notify','digest');
        DROP TABLE scheduler_settings;`);
    }
    const now = sqlString(new Date().toISOString());
    db.exec(`INSERT OR IGNORE INTO user_vacancies(user_id,vacancy_id,decision,first_relevant_at,updated_at)
      SELECT ${owner},id,decision,COALESCE(first_seen_at,${now}),COALESCE(updated_at,${now}) FROM vacancies;`);
    db.prepare("INSERT INTO app_migrations(name,applied_at) VALUES ('multiuser-v1',?)").run(new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
} else if (!db.prepare("SELECT 1 FROM app_migrations WHERE name='multiuser-v1'").get()) {
  db.prepare("INSERT INTO app_migrations(name,applied_at) VALUES ('multiuser-v1',?)").run(new Date().toISOString());
}

if (!columns('cv_templates').includes('document_json')) {
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec('BEGIN');
  try {
    db.exec(`ALTER TABLE cv_templates RENAME TO cv_templates_file_storage;
      CREATE TABLE cv_templates (
        user_id TEXT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        language TEXT NOT NULL CHECK (language IN ('ru','en')),cv_sha256 TEXT NOT NULL,cv_text TEXT NOT NULL,
        document_json TEXT NOT NULL,source_format TEXT NOT NULL CHECK (source_format IN ('pdf','md','txt','doc','docx')),
        original_filename TEXT NOT NULL,media_type TEXT NOT NULL,parser_name TEXT NOT NULL,parser_version TEXT NOT NULL,
        updated_at TEXT NOT NULL,PRIMARY KEY (user_id,language));
      INSERT INTO cv_templates SELECT user_id,language,cv_sha256,cv_text,
        json_object('version',1,'blocks',json_array(json_object('type','paragraph','text',cv_text))),
        'pdf',language||'.pdf','application/pdf','legacy-unpdf','1',updated_at FROM cv_templates_file_storage;
      DROP TABLE cv_templates_file_storage;`);
    db.prepare("INSERT OR REPLACE INTO app_migrations(name,applied_at) VALUES ('cv-text-storage-v2',?)")
      .run(new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
}

// Incremental compatibility for older candidate/vacancy layouts.
const vacancyColumns = columns('vacancies');
if (!vacancyColumns.includes('apply_id')) {
  db.exec("ALTER TABLE vacancies ADD COLUMN apply_id TEXT CHECK(length(apply_id)=6 AND apply_id NOT GLOB '*[^a-z]*')");
}
if (!vacancyColumns.includes('source')) db.exec('ALTER TABLE vacancies ADD COLUMN source TEXT');
if (!vacancyColumns.includes('source_id')) db.exec('ALTER TABLE vacancies ADD COLUMN source_id TEXT');
if (!vacancyColumns.includes('canonical_fingerprint')) db.exec('ALTER TABLE vacancies ADD COLUMN canonical_fingerprint TEXT');
db.exec("UPDATE vacancies SET source=COALESCE(source,'hh'),source_id=COALESCE(source_id,hh_id)");

const candidateColumns = columns('vacancy_candidates');
if (!candidateColumns.includes('semantic_status')) {
  db.exec("ALTER TABLE vacancy_candidates ADD COLUMN semantic_status TEXT NOT NULL DEFAULT 'disabled' CHECK (semantic_status IN ('ready','skipped','disabled','unavailable'))");
}

function newApplyId(): string {
  return Array.from({ length: 6 }, () => String.fromCharCode(97 + randomInt(26))).join('');
}
function canonicalFingerprint(name: string, employer: string): string {
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return createHash('sha256').update(`${normalize(name)}|${normalize(employer)}`).digest('hex');
}
function descriptionSimilarity(left: string, right: string): number {
  const tokens = (value: string) => new Set(value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const a = tokens(left); const b = tokens(right); if (!a.size || !b.size) return 0;
  let intersection = 0; for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS vacancies_source_id_idx ON vacancies(source,source_id)');
const saveCanonicalFingerprint = db.prepare('UPDATE vacancies SET canonical_fingerprint=? WHERE id=?');
for (const row of db.prepare('SELECT id,name,employer FROM vacancies WHERE canonical_fingerprint IS NULL').all()) {
  saveCanonicalFingerprint.run(canonicalFingerprint(String(row.name), String(row.employer)), row.id);
}
db.exec('CREATE INDEX IF NOT EXISTS vacancies_canonical_idx ON vacancies(canonical_fingerprint)');
const applyIdExists = db.prepare('SELECT 1 FROM vacancies WHERE apply_id=?');
const saveApplyId = db.prepare('UPDATE vacancies SET apply_id=? WHERE id=?');
for (const row of db.prepare('SELECT id FROM vacancies WHERE apply_id IS NULL').all()) {
  let applyId: string;
  do applyId = newApplyId(); while (applyIdExists.get(applyId));
  saveApplyId.run(applyId, row.id);
}
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS vacancies_apply_id_idx ON vacancies(apply_id);
CREATE INDEX IF NOT EXISTS user_vacancies_decision_idx ON user_vacancies(user_id,decision);
CREATE INDEX IF NOT EXISTS scores_user_score_idx ON scores(user_id,score DESC);
CREATE INDEX IF NOT EXISTS prefilter_queue_idx ON prefilter_scores(user_id,context_hash,filtered,combined_score DESC);
CREATE INDEX IF NOT EXISTS candidate_queue_idx ON vacancy_candidates(status,combined_score DESC,published_at DESC);
CREATE INDEX IF NOT EXISTS candidate_discoveries_user_idx ON candidate_discoveries(user_id,last_seen_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_user_kind_time_idx ON usage_events(user_id,kind,occurred_at DESC);
`);

db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS vacancies_fts USING fts5(name,employer,description,key_skills,tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS vacancies_fts_insert AFTER INSERT ON vacancies BEGIN
  INSERT INTO vacancies_fts(rowid,name,employer,description,key_skills)
  VALUES (new.id,new.name,new.employer,new.description,new.key_skills_json);
END;
CREATE TRIGGER IF NOT EXISTS vacancies_fts_update AFTER UPDATE OF name,employer,description,key_skills_json ON vacancies BEGIN
  DELETE FROM vacancies_fts WHERE rowid=old.id;
  INSERT INTO vacancies_fts(rowid,name,employer,description,key_skills)
  VALUES (new.id,new.name,new.employer,new.description,new.key_skills_json);
END;
CREATE TRIGGER IF NOT EXISTS vacancies_fts_delete AFTER DELETE ON vacancies BEGIN
  DELETE FROM vacancies_fts WHERE rowid=old.id;
END;
`);
const vacancyFtsCount = Number(db.prepare('SELECT COUNT(*) count FROM vacancies_fts').get()?.count ?? 0);
const vacancyCount = Number(db.prepare('SELECT COUNT(*) count FROM vacancies').get()?.count ?? 0);
if (vacancyFtsCount !== vacancyCount) {
  db.exec(`DELETE FROM vacancies_fts;
    INSERT INTO vacancies_fts(rowid,name,employer,description,key_skills)
    SELECT id,name,employer,description,key_skills_json FROM vacancies;`);
}

export type UserStatus = 'unregistered' | 'pending' | 'approved' | 'rejected' | 'revoked';
export interface TelegramUser {
  userId: string; chatId: string; username: string | null; displayName: string;
  status: UserStatus; isOwner: boolean; requestedAt: string | null; approvedAt: string | null;
}
export interface TelegramIdentity { userId: string; chatId: string; username?: string; displayName: string }

function rowToUser(row: Record<string, unknown>): TelegramUser {
  return { userId: String(row.user_id), chatId: String(row.chat_id),
    username: row.username == null ? null : String(row.username), displayName: String(row.display_name),
    status: String(row.status) as UserStatus, isOwner: Boolean(row.is_owner),
    requestedAt: row.requested_at == null ? null : String(row.requested_at),
    approvedAt: row.approved_at == null ? null : String(row.approved_at) };
}
export function getTelegramUser(userId: string): TelegramUser | null {
  const row = db.prepare('SELECT * FROM telegram_users WHERE user_id=?').get(userId);
  return row ? rowToUser(row) : null;
}
export function isApprovedUser(userId: string): boolean {
  const user = getTelegramUser(userId);
  return Boolean(user && (user.status === 'approved' || user.isOwner));
}
export function requireApprovedUser(userId: string): TelegramUser {
  const user = getTelegramUser(userId);
  if (!user || (user.status !== 'approved' && !user.isOwner)) throw new Error('User access is not approved.');
  return user;
}
export function touchTelegramUser(identity: TelegramIdentity): TelegramUser {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO telegram_users(user_id,chat_id,username,display_name,status,updated_at)
    VALUES (?,?,?,?,'unregistered',?) ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id,
    username=excluded.username,display_name=excluded.display_name,updated_at=excluded.updated_at`)
    .run(identity.userId, identity.chatId, identity.username ?? null, identity.displayName, now);
  return getTelegramUser(identity.userId)!;
}
export interface AccessRequestResult { user: TelegramUser; notifyOwner: boolean; retryAfterSeconds: number }
export function requestAccess(identity: TelegramIdentity): AccessRequestResult {
  const current = touchTelegramUser(identity);
  if (current.isOwner || current.status === 'approved') return { user: current, notifyOwner: false, retryAfterSeconds: 0 };
  if (current.status === 'pending') return { user: current, notifyOwner: false, retryAfterSeconds: 0 };
  const cooldownMs = config.accessRequestCooldownMinutes * 60_000;
  const requestedAt = current.requestedAt ? Date.parse(current.requestedAt) : 0;
  const remaining = requestedAt + cooldownMs - Date.now();
  if ((current.status === 'rejected' || current.status === 'revoked') && remaining > 0) {
    return { user: current, notifyOwner: false, retryAfterSeconds: Math.ceil(remaining / 1_000) };
  }
  const now = new Date().toISOString();
  db.prepare(`UPDATE telegram_users SET status='pending',requested_at=?,updated_at=? WHERE user_id=?`).run(now, now, identity.userId);
  return { user: getTelegramUser(identity.userId)!, notifyOwner: true, retryAfterSeconds: 0 };
}
export function setUserStatus(userId: string, status: 'approved' | 'rejected' | 'revoked'): TelegramUser | null {
  const now = new Date().toISOString();
  db.prepare(`UPDATE telegram_users SET status=CASE WHEN is_owner<>0 THEN 'approved' ELSE ? END,
    approved_at=CASE WHEN ?='approved' THEN ? ELSE approved_at END,
    requested_at=CASE WHEN ? IN ('rejected','revoked') THEN ? ELSE requested_at END,updated_at=? WHERE user_id=?`)
    .run(status, status, now, status, now, now, userId);
  if (status !== 'approved') db.prepare('DELETE FROM pending_deliveries WHERE user_id=?').run(userId);
  return getTelegramUser(userId);
}
export function listTelegramUsers(limit: number, offset: number): { users: TelegramUser[]; total: number } {
  const users = db.prepare(`SELECT * FROM telegram_users ORDER BY is_owner DESC,
    CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,updated_at DESC LIMIT ? OFFSET ?`)
    .all(limit, offset).map(rowToUser);
  const total = Number(db.prepare('SELECT COUNT(*) count FROM telegram_users').get()?.count ?? 0);
  return { users, total };
}
export function approvedUsers(requireCv = false): TelegramUser[] {
  const cvClause = requireCv ? `AND EXISTS (SELECT 1 FROM cv_templates c WHERE c.user_id=u.user_id AND c.language='ru')
    AND EXISTS (SELECT 1 FROM cv_templates c WHERE c.user_id=u.user_id AND c.language='en')` : '';
  return db.prepare(`SELECT u.* FROM telegram_users u WHERE u.status='approved' ${cvClause} ORDER BY u.is_owner DESC,u.user_id`)
    .all().map(rowToUser);
}

export type UsageKind = 'score' | 'application' | 'search-profile';
export interface UserUsageSummary {
  userId: string; displayName: string; scores24h: number; applications24h: number;
  searchProfiles24h: number; scoresTotal: number; applicationsTotal: number;
}
export function recordUsage(userId: string, kind: UsageKind): void {
  if (!hasCompleteCv(userId)) throw new Error('Both CV templates are required.');
  db.prepare('INSERT INTO usage_events(user_id,kind,occurred_at) VALUES (?,?,?)').run(userId, kind, new Date().toISOString());
}
export function usageInLast24Hours(userId: string, kind: UsageKind): number {
  return Number(db.prepare(`SELECT COUNT(*) count FROM usage_events WHERE user_id=? AND kind=?
    AND julianday(occurred_at)>=julianday('now','-1 day')`).get(userId, kind)?.count ?? 0);
}
export function userUsageSummaries(): UserUsageSummary[] {
  return db.prepare(`SELECT u.user_id,u.display_name,
    SUM(CASE WHEN e.kind='score' AND julianday(e.occurred_at)>=julianday('now','-1 day') THEN 1 ELSE 0 END) scores_24h,
    SUM(CASE WHEN e.kind='application' AND julianday(e.occurred_at)>=julianday('now','-1 day') THEN 1 ELSE 0 END) applications_24h,
    SUM(CASE WHEN e.kind='search-profile' AND julianday(e.occurred_at)>=julianday('now','-1 day') THEN 1 ELSE 0 END) profiles_24h,
    SUM(CASE WHEN e.kind='score' THEN 1 ELSE 0 END) scores_total,
    SUM(CASE WHEN e.kind='application' THEN 1 ELSE 0 END) applications_total
    FROM telegram_users u LEFT JOIN usage_events e ON e.user_id=u.user_id
    GROUP BY u.user_id,u.display_name ORDER BY u.is_owner DESC,u.user_id`).all().map((row) => ({
      userId: String(row.user_id), displayName: String(row.display_name), scores24h: Number(row.scores_24h),
      applications24h: Number(row.applications_24h), searchProfiles24h: Number(row.profiles_24h),
      scoresTotal: Number(row.scores_total), applicationsTotal: Number(row.applications_total),
    }));
}

export function deleteUserData(userId: string): void {
  db.exec('BEGIN');
  try {
    for (const table of ['candidate_discoveries','pending_deliveries','user_delivery_windows','applications','scores',
      'prefilter_scores','user_vacancies','search_profiles','cv_templates','usage_events'] as const) {
      db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
    }
    db.prepare("DELETE FROM embedding_cache WHERE kind='cv' AND user_id=?").run(userId);
    if (tableExists('flue_agent_submissions')) {
      const sessionPattern = `%\"${userId.replaceAll('%', '\\%').replaceAll('_', '\\_')}-%`;
      const submissionIds = db.prepare("SELECT submission_id FROM flue_agent_submissions WHERE session_key LIKE ? ESCAPE '\\'")
        .all(sessionPattern).map((row) => String(row.submission_id));
      for (const submissionId of submissionIds) {
        db.prepare('DELETE FROM flue_submission_chunks WHERE submission_id=?').run(submissionId);
        db.prepare('DELETE FROM flue_conversation_stream_batches WHERE submission_id=?').run(submissionId);
        db.prepare('DELETE FROM flue_agent_submissions WHERE submission_id=?').run(submissionId);
      }
      const streamPattern = `%/${userId.replaceAll('%', '\\%').replaceAll('_', '\\_')}-%`;
      const paths = db.prepare("SELECT path FROM flue_conversation_streams WHERE path LIKE ? ESCAPE '\\'")
        .all(streamPattern).map((row) => String(row.path));
      for (const path of paths) {
        db.prepare('DELETE FROM flue_attachment_chunks WHERE stream_path=?').run(path);
        db.prepare('DELETE FROM flue_attachments WHERE stream_path=?').run(path);
        db.prepare('DELETE FROM flue_conversation_stream_batch_chunks WHERE path=?').run(path);
        db.prepare('DELETE FROM flue_conversation_stream_batches WHERE path=?').run(path);
        db.prepare('DELETE FROM flue_conversation_streams WHERE path=?').run(path);
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function exportUserData(userId: string): Record<string, unknown> {
  const user = getTelegramUser(userId);
  if (!user) throw new Error('User was not found.');
  const cvTemplates = db.prepare(`SELECT language,cv_sha256,cv_text,document_json,source_format,original_filename,
    media_type,parser_name,parser_version,updated_at FROM cv_templates WHERE user_id=? ORDER BY language`).all(userId)
    .map((row) => ({ ...row, document_json: JSON.parse(String(row.document_json)) }));
  const profiles = db.prepare('SELECT platform,profile_json,updated_at FROM search_profiles WHERE user_id=? ORDER BY platform').all(userId)
    .map((row) => ({ platform: row.platform, profile: JSON.parse(String(row.profile_json)), updatedAt: row.updated_at }));
  const scores = db.prepare(`SELECT s.vacancy_id,v.apply_id,v.source,v.source_id,v.name,v.employer,v.url,s.score,s.primary_track,
    s.summary,s.reasons_json,s.gaps_json,s.hard_rejection,s.scored_at,uv.decision FROM scores s
    JOIN vacancies v ON v.id=s.vacancy_id LEFT JOIN user_vacancies uv ON uv.user_id=s.user_id AND uv.vacancy_id=s.vacancy_id
    WHERE s.user_id=? ORDER BY s.scored_at DESC`).all(userId).map((row) => ({ ...row,
      reasons_json: JSON.parse(String(row.reasons_json)), gaps_json: JSON.parse(String(row.gaps_json)) }));
  return { exportedAt: new Date().toISOString(), user, deliveryWindow: getDeliveryWindow(userId),
    cvTemplates, searchProfiles: profiles, scores,
    usage: db.prepare('SELECT kind,occurred_at FROM usage_events WHERE user_id=? ORDER BY occurred_at').all(userId),
    discoveries: db.prepare(`SELECT source,source_id,search_name,first_seen_at,last_seen_at FROM candidate_discoveries
      WHERE user_id=? ORDER BY last_seen_at DESC`).all(userId) };
}

export interface Vacancy {
  id: number; source: string; sourceId: string; applyId: string; name: string; employer: string; area: string;
  salaryFrom: number | null; salaryTo: number | null; salaryCurrency: string | null; salaryGross: boolean | null;
  experience: string; employment: string; schedule: string; workFormat: string; description: string; keySkills: string[];
  url: string; publishedAt: string; sourceQuery: string; contentHash: string; decision: string;
}
export interface VacancyInput extends Omit<Vacancy, 'id' | 'applyId' | 'decision'> {}
function rowToVacancy(row: Record<string, unknown>): Vacancy {
  const source = String(row.source ?? 'hh');
  return { id: Number(row.id), source, sourceId: String(row.source_id ?? row.hh_id),
    applyId: String(row.apply_id), name: String(row.name), employer: String(row.employer), area: String(row.area),
    salaryFrom: row.salary_from == null ? null : Number(row.salary_from), salaryTo: row.salary_to == null ? null : Number(row.salary_to),
    salaryCurrency: row.salary_currency == null ? null : String(row.salary_currency),
    salaryGross: row.salary_gross == null ? null : Boolean(row.salary_gross), experience: String(row.experience),
    employment: String(row.employment), schedule: String(row.schedule), workFormat: String(row.work_format),
    description: String(row.description), keySkills: JSON.parse(String(row.key_skills_json)) as string[],
    url: safeVacancyUrl(source, String(row.url)), publishedAt: String(row.published_at), sourceQuery: String(row.source_query),
    contentHash: String(row.content_hash), decision: String(row.user_decision ?? row.decision ?? 'new') };
}

export type CvLanguage = 'ru' | 'en';
export interface CvTemplate {
  language: CvLanguage; cvSha256: string; cvText: string; document: CanonicalCvDocument;
  sourceFormat: CvSourceFormat; originalFilename: string; mediaType: string; parserName: string; parserVersion: string;
}
export function getCvTemplate(userId: string, language: CvLanguage): CvTemplate | null {
  const row = db.prepare(`SELECT language,cv_sha256,cv_text,document_json,source_format,original_filename,
    media_type,parser_name,parser_version FROM cv_templates WHERE user_id=? AND language=?`).get(userId, language);
  return row ? { language: String(row.language) as CvLanguage, cvSha256: String(row.cv_sha256), cvText: String(row.cv_text),
    document: JSON.parse(String(row.document_json)) as CanonicalCvDocument, sourceFormat: String(row.source_format) as CvSourceFormat,
    originalFilename: String(row.original_filename), mediaType: String(row.media_type), parserName: String(row.parser_name),
    parserVersion: String(row.parser_version) } : null;
}
export function getCvBundleHash(userId: string): string | null {
  const rows = db.prepare('SELECT language,cv_sha256 FROM cv_templates WHERE user_id=? ORDER BY language').all(userId);
  if (rows.length !== 2) return null;
  return createHash('sha256').update(rows.map((row) => `${row.language}:${row.cv_sha256}`).join('|')).digest('hex');
}
export function saveCvTemplate(userId: string, language: CvLanguage, originalFilename: string,
  cvSha256: string, extracted: ExtractedCvDocument): void {
  db.prepare(`INSERT INTO cv_templates
    (user_id,language,cv_sha256,cv_text,document_json,source_format,original_filename,media_type,parser_name,parser_version,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,language) DO UPDATE SET cv_sha256=excluded.cv_sha256,
    cv_text=excluded.cv_text,document_json=excluded.document_json,source_format=excluded.source_format,
    original_filename=excluded.original_filename,media_type=excluded.media_type,parser_name=excluded.parser_name,
    parser_version=excluded.parser_version,updated_at=excluded.updated_at`)
    .run(userId, language, cvSha256, extracted.text, JSON.stringify(extracted.document), extracted.sourceFormat,
      originalFilename, extracted.mediaType, extracted.parserName, extracted.parserVersion, new Date().toISOString());
  db.prepare('DELETE FROM scores WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM prefilter_scores WHERE user_id=?').run(userId);
}
function hasCompleteCv(userId: string): boolean {
  return Number(db.prepare('SELECT COUNT(*) count FROM cv_templates WHERE user_id=?').get(userId)?.count ?? 0) >= 2;
}
export function saveSearchProfile(userId: string, platform: string, profile: unknown): void {
  if (!hasCompleteCv(userId)) throw new Error('Both CV templates are required.');
  db.prepare(`INSERT INTO search_profiles (user_id,platform,profile_json,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id,platform) DO UPDATE SET profile_json=excluded.profile_json,updated_at=excluded.updated_at`)
    .run(userId, platform, JSON.stringify(profile), new Date().toISOString());
}
export function clearSearchProfile(userId: string, platform: string): void {
  db.prepare('DELETE FROM search_profiles WHERE user_id=? AND platform=?').run(userId, platform);
}
export function getSearchProfile<T>(userId: string, platform: string): T | null {
  const row = db.prepare('SELECT profile_json FROM search_profiles WHERE user_id=? AND platform=?').get(userId, platform);
  return row ? JSON.parse(String(row.profile_json)) as T : null;
}

export type GlobalScheduleName = 'scrape' | 'notify' | 'digest';
export function getGlobalScheduleCron(name: GlobalScheduleName): string | null {
  const row = db.prepare('SELECT cron FROM global_scheduler_settings WHERE name=?').get(name);
  return row ? String(row.cron) : null;
}
export function saveGlobalScheduleCron(name: GlobalScheduleName, cron: string): void {
  db.prepare(`INSERT INTO global_scheduler_settings(name,cron,updated_at) VALUES (?,?,?)
    ON CONFLICT(name) DO UPDATE SET cron=excluded.cron,updated_at=excluded.updated_at`).run(name, cron, new Date().toISOString());
}
export interface DeliveryWindow { startMinutes: number; endMinutes: number; timezone: string }
export function getDeliveryWindow(userId: string): DeliveryWindow | null {
  const row = db.prepare('SELECT start_minutes,end_minutes,timezone FROM user_delivery_windows WHERE user_id=?').get(userId);
  return row ? { startMinutes: Number(row.start_minutes), endMinutes: Number(row.end_minutes), timezone: String(row.timezone) } : null;
}
export function saveDeliveryWindow(userId: string, window: DeliveryWindow | null): void {
  if (!window) { db.prepare('DELETE FROM user_delivery_windows WHERE user_id=?').run(userId); return; }
  db.prepare(`INSERT INTO user_delivery_windows(user_id,start_minutes,end_minutes,timezone,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET start_minutes=excluded.start_minutes,end_minutes=excluded.end_minutes,
    timezone=excluded.timezone,updated_at=excluded.updated_at`)
    .run(userId, window.startMinutes, window.endMinutes, window.timezone, new Date().toISOString());
}
export type DeliveryKind = 'notify' | 'digest';
export function queueDelivery(userId: string, kind: DeliveryKind): void {
  db.prepare(`INSERT INTO pending_deliveries(user_id,kind,queued_at) VALUES (?,?,?)
    ON CONFLICT(user_id,kind) DO NOTHING`).run(userId, kind, new Date().toISOString());
}
export function pendingDeliveries(): Array<{ userId: string; kind: DeliveryKind }> {
  return db.prepare(`SELECT p.user_id,p.kind FROM pending_deliveries p JOIN telegram_users u ON u.user_id=p.user_id
    WHERE u.status='approved' ORDER BY p.queued_at`).all()
    .map((row) => ({ userId: String(row.user_id), kind: String(row.kind) as DeliveryKind }));
}
export function clearPendingDelivery(userId: string, kind: DeliveryKind): void {
  db.prepare('DELETE FROM pending_deliveries WHERE user_id=? AND kind=?').run(userId, kind);
}

export function upsertVacancy(v: VacancyInput): { id: number; needsScore: boolean; duplicate: boolean } {
  v = { ...v, url: safeVacancyUrl(v.source, v.url) };
  const existing = db.prepare('SELECT id,content_hash FROM vacancies WHERE source=? AND source_id=?').get(v.source, v.sourceId);
  const now = new Date().toISOString();
  const values = [v.name, v.employer, v.area, v.salaryFrom, v.salaryTo, v.salaryCurrency,
    v.salaryGross == null ? null : Number(v.salaryGross), v.experience, v.employment, v.schedule, v.workFormat,
    v.description, JSON.stringify(v.keySkills), v.url, v.publishedAt, v.sourceQuery, v.contentHash, now] as const;
  if (!existing) {
    const fingerprint = canonicalFingerprint(v.name, v.employer);
    const duplicate = db.prepare('SELECT id,description FROM vacancies WHERE canonical_fingerprint=? ORDER BY id DESC LIMIT 10')
      .all(fingerprint).find((row) => descriptionSimilarity(String(row.description), v.description) >= 0.55);
    if (duplicate) return { id: Number(duplicate.id), needsScore: false, duplicate: true };
    let applyId: string; do applyId = newApplyId(); while (applyIdExists.get(applyId));
    const result = db.prepare(`INSERT INTO vacancies
      (hh_id,source,source_id,apply_id,name,employer,area,salary_from,salary_to,salary_currency,salary_gross,experience,employment,
       schedule,work_format,description,key_skills_json,url,published_at,source_query,content_hash,canonical_fingerprint,first_seen_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(`${v.source}:${v.sourceId}`, v.source, v.sourceId, applyId, ...values.slice(0, 17), fingerprint, now, now);
    return { id: Number(result.lastInsertRowid), needsScore: true, duplicate: false };
  }
  const id = Number(existing.id); const changed = String(existing.content_hash) !== v.contentHash;
  db.prepare(`UPDATE vacancies SET name=?,employer=?,area=?,salary_from=?,salary_to=?,salary_currency=?,salary_gross=?,
    experience=?,employment=?,schedule=?,work_format=?,description=?,key_skills_json=?,url=?,published_at=?,source_query=?,
    content_hash=?,updated_at=? WHERE id=?`).run(...values, id);
  if (changed) {
    db.prepare('DELETE FROM scores WHERE vacancy_id=?').run(id);
    db.prepare('DELETE FROM prefilter_scores WHERE vacancy_id=?').run(id);
  }
  return { id, needsScore: changed, duplicate: false };
}
export function hasVacancySourceId(source: string, sourceId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM vacancies WHERE source=? AND source_id=?').get(source, sourceId));
}

export interface VacancyCandidateInput { source: string; sourceId: string; url: string; searchName: string; title: string; summary?: string; publishedAt?: string; payload?: unknown }
export interface VacancyCandidate extends Omit<VacancyCandidateInput, 'summary' | 'publishedAt'> {
  summary: string; publishedAt: string; listingHash: string; status: string; attempts: number; combinedScore: number | null;
}
export function recordVacancyCandidate(userId: string, input: VacancyCandidateInput): boolean {
  input = { ...input, url: safeVacancyUrl(input.source, input.url) };
  const now = new Date().toISOString(); const summary = input.summary ?? ''; const publishedAt = input.publishedAt ?? now;
  const payloadJson = JSON.stringify(input.payload ?? null);
  const listingHash = createHash('sha256').update(JSON.stringify([input.title, summary, input.url, payloadJson])).digest('hex');
  const existingVacancy = db.prepare('SELECT id FROM vacancies WHERE source=? AND source_id=?').get(input.source, input.sourceId);
  const existing = db.prepare('SELECT status,listing_hash FROM vacancy_candidates WHERE source=? AND source_id=?')
    .get(input.source, input.sourceId);
  const discovered = !existing && !existingVacancy;
  if (!existing) {
    db.prepare(`INSERT INTO vacancy_candidates
      (source,source_id,url,search_name,title,summary,published_at,payload_json,listing_hash,status,vacancy_id,first_seen_at,last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.source, input.sourceId, input.url, input.searchName, input.title,
        summary, publishedAt, payloadJson, listingHash, existingVacancy ? 'normalized' : 'discovered',
        existingVacancy ? Number(existingVacancy.id) : null, now, now);
  } else {
    const changed = String(existing.listing_hash) !== listingHash;
    db.prepare(`UPDATE vacancy_candidates SET url=?,search_name=?,title=?,summary=?,published_at=?,payload_json=?,listing_hash=?,last_seen_at=?,
      prefilter_context_hash=CASE WHEN ? THEN NULL ELSE prefilter_context_hash END,
      status=CASE WHEN ? AND status IN ('filtered','failed','queued','discovered') THEN 'discovered' ELSE status END
      WHERE source=? AND source_id=?`).run(input.url, input.searchName, input.title, summary, publishedAt, payloadJson,
        listingHash, now, Number(changed), Number(changed), input.source, input.sourceId);
  }
  if (hasCompleteCv(userId)) {
    db.prepare(`INSERT INTO candidate_discoveries(user_id,source,source_id,search_name,first_seen_at,last_seen_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,source,source_id) DO UPDATE SET
      search_name=excluded.search_name,last_seen_at=excluded.last_seen_at`)
      .run(userId, input.source, input.sourceId, input.searchName, now, now);
  }
  return discovered;
}
function rowToCandidate(row: Record<string, unknown>): VacancyCandidate {
  return { source: String(row.source), sourceId: String(row.source_id), url: String(row.url), searchName: String(row.search_name),
    title: String(row.title), summary: String(row.summary), publishedAt: String(row.published_at),
    payload: JSON.parse(String(row.payload_json)), listingHash: String(row.listing_hash), status: String(row.status),
    attempts: Number(row.attempts), combinedScore: row.combined_score == null ? null : Number(row.combined_score) };
}
export function candidatesNeedingPrefilter(contextHash: string, limit: number): VacancyCandidate[] {
  return db.prepare(`SELECT * FROM vacancy_candidates WHERE status IN ('discovered','queued','filtered','failed')
    AND (prefilter_context_hash IS NULL OR prefilter_context_hash<>? OR semantic_status='unavailable') ORDER BY last_seen_at DESC LIMIT ?`)
    .all(contextHash, limit).map(rowToCandidate);
}
export function saveCandidatePrefilter(candidate: VacancyCandidate, contextHash: string, score: PrefilterScoreInput): void {
  db.prepare(`UPDATE vacancy_candidates SET prefilter_context_hash=?,regex_score=?,lexical_cosine=?,semantic_cosine=?,semantic_status=?,
    combined_score=?,filter_reasons_json=?,status=? WHERE source=? AND source_id=?`).run(contextHash, score.regexScore,
      score.embeddingCosine, score.semanticCosine, score.semanticStatus, score.combinedScore, JSON.stringify(score.reasons),
      score.filtered ? 'filtered' : 'queued', candidate.source, candidate.sourceId);
}
export function rankedCandidateQueue(limit: number): VacancyCandidate[] {
  return db.prepare(`SELECT * FROM vacancy_candidates WHERE status IN ('queued','failed') AND (next_retry_at IS NULL OR next_retry_at<=?)
    ORDER BY combined_score DESC,published_at DESC LIMIT ?`).all(new Date().toISOString(), limit).map(rowToCandidate);
}
export function candidatesDueForRefresh(limit: number, days: number): VacancyCandidate[] {
  const before = new Date(Date.now() - days * 86_400_000).toISOString();
  return db.prepare(`SELECT * FROM vacancy_candidates WHERE status='normalized' AND (last_checked_at IS NULL OR last_checked_at<?)
    ORDER BY COALESCE(last_checked_at,first_seen_at) LIMIT ?`).all(before, limit).map(rowToCandidate);
}
export function markCandidateNormalized(candidate: VacancyCandidate, vacancyId: number, duplicate = false): void {
  db.prepare(`UPDATE vacancy_candidates SET status=?,vacancy_id=?,attempts=attempts+1,last_checked_at=?,last_error=NULL,next_retry_at=NULL
    WHERE source=? AND source_id=?`).run(duplicate ? 'duplicate' : 'normalized', vacancyId, new Date().toISOString(), candidate.source, candidate.sourceId);
}
export function markCandidateClosed(candidate: VacancyCandidate): void {
  db.prepare(`UPDATE vacancy_candidates SET status='closed',attempts=attempts+1,last_checked_at=?,last_error=NULL
    WHERE source=? AND source_id=?`).run(new Date().toISOString(), candidate.source, candidate.sourceId);
}
export function markCandidateFailed(candidate: VacancyCandidate, error: string): void {
  const attempts = candidate.attempts + 1; const delayMinutes = Math.min(24 * 60, 2 ** Math.min(attempts, 10));
  db.prepare(`UPDATE vacancy_candidates SET status='failed',attempts=?,last_checked_at=?,last_error=?,next_retry_at=?
    WHERE source=? AND source_id=?`).run(attempts, new Date().toISOString(), error.slice(0, 1000),
      new Date(Date.now() + delayMinutes * 60_000).toISOString(), candidate.source, candidate.sourceId);
}

export function getVacancy(id: number): Vacancy | null {
  const row = db.prepare('SELECT * FROM vacancies WHERE id=?').get(id); return row ? rowToVacancy(row) : null;
}
function ensureUserVacancy(userId: string, vacancyId: number): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO user_vacancies(user_id,vacancy_id,first_relevant_at,updated_at) VALUES (?,?,?,?)`)
    .run(userId, vacancyId, now, now);
}
export function pendingVacancies(userId: string, limit: number): Vacancy[] {
  return db.prepare(`SELECT v.*,COALESCE(uv.decision,'new') user_decision FROM vacancies v
    LEFT JOIN scores s ON s.user_id=? AND s.vacancy_id=v.id LEFT JOIN user_vacancies uv ON uv.user_id=? AND uv.vacancy_id=v.id
    WHERE s.vacancy_id IS NULL AND COALESCE(uv.decision,'new') NOT IN ('skipped','applied')
    ORDER BY v.published_at DESC LIMIT ?`).all(userId, userId, limit).map(rowToVacancy);
}
export function vacanciesNeedingPrefilter(userId: string, contextHash: string, limit: number, semanticRequired = false): Vacancy[] {
  return db.prepare(`SELECT v.*,COALESCE(uv.decision,'new') user_decision FROM vacancies v
    LEFT JOIN scores s ON s.user_id=? AND s.vacancy_id=v.id
    LEFT JOIN prefilter_scores p ON p.user_id=? AND p.vacancy_id=v.id
    LEFT JOIN user_vacancies uv ON uv.user_id=? AND uv.vacancy_id=v.id
    WHERE s.vacancy_id IS NULL AND COALESCE(uv.decision,'new') NOT IN ('skipped','applied')
    AND (p.vacancy_id IS NULL OR p.context_hash<>? OR p.content_hash<>v.content_hash
      OR (?<>0 AND p.semantic_status IN ('disabled','unavailable')))
    ORDER BY v.published_at DESC LIMIT ?`).all(userId, userId, userId, contextHash, Number(semanticRequired), limit).map(rowToVacancy);
}

export function getCachedEmbedding(model: string, kind: 'cv' | 'vacancy', userId: string, contentHash: string): Float32Array | null {
  const row = db.prepare('SELECT dimensions,vector FROM embedding_cache WHERE model=? AND kind=? AND user_id=? AND content_hash=?')
    .get(model, kind, userId, contentHash);
  if (!row) return null;
  const bytes = Uint8Array.from(row.vector as Uint8Array); const dimensions = Number(row.dimensions);
  return bytes.byteLength === dimensions * Float32Array.BYTES_PER_ELEMENT ? new Float32Array(bytes.buffer) : null;
}
export function saveCachedEmbedding(model: string, kind: 'cv' | 'vacancy', userId: string, contentHash: string, vector: Float32Array): void {
  const bytes = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  db.prepare(`INSERT INTO embedding_cache(model,kind,user_id,content_hash,dimensions,vector,created_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(model,kind,user_id,content_hash) DO UPDATE SET dimensions=excluded.dimensions,vector=excluded.vector,created_at=excluded.created_at`)
    .run(model, kind, userId, contentHash, vector.length, bytes, new Date().toISOString());
}

export interface PrefilterScoreInput {
  regexScore: number; embeddingCosine: number; embeddingScore: number; semanticCosine: number | null; semanticScore: number | null;
  semanticStatus: 'ready' | 'skipped' | 'disabled' | 'unavailable'; combinedScore: number; filtered: boolean;
  auditSelected: boolean; reasons: string[];
}
export function savePrefilterScore(userId: string, vacancyId: number, contextHash: string, contentHash: string, score: PrefilterScoreInput): void {
  if (!hasCompleteCv(userId)) throw new Error('Both CV templates are required.');
  ensureUserVacancy(userId, vacancyId);
  db.prepare(`INSERT INTO prefilter_scores
    (user_id,vacancy_id,context_hash,content_hash,regex_score,embedding_cosine,embedding_score,semantic_cosine,semantic_score,
     semantic_status,combined_score,filtered,audit_selected,reasons_json,scored_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,vacancy_id) DO UPDATE SET
    context_hash=excluded.context_hash,content_hash=excluded.content_hash,regex_score=excluded.regex_score,
    embedding_cosine=excluded.embedding_cosine,embedding_score=excluded.embedding_score,semantic_cosine=excluded.semantic_cosine,
    semantic_score=excluded.semantic_score,semantic_status=excluded.semantic_status,combined_score=excluded.combined_score,
    filtered=excluded.filtered,audit_selected=excluded.audit_selected,reasons_json=excluded.reasons_json,scored_at=excluded.scored_at`)
    .run(userId, vacancyId, contextHash, contentHash, score.regexScore, score.embeddingCosine, score.embeddingScore,
      score.semanticCosine, score.semanticScore, score.semanticStatus, score.combinedScore, Number(score.filtered), Number(score.auditSelected),
      JSON.stringify(score.reasons), new Date().toISOString());
}
export interface PrefilteredVacancy extends Vacancy { prefilterScore: number; auditSelected: boolean }
function rowsToPrefiltered(rows: Record<string, unknown>[]): PrefilteredVacancy[] {
  return rows.map((row) => ({ ...rowToVacancy(row), prefilterScore: Number(row.prefilter_score), auditSelected: Boolean(row.audit_selected) }));
}
export function rankedPendingVacancies(userId: string, contextHash: string, limit: number, auditSlots = 0): PrefilteredVacancy[] {
  const query = (filtered: boolean, queryLimit: number) => rowsToPrefiltered(db.prepare(`SELECT v.*,uv.decision user_decision,
      p.combined_score prefilter_score,p.audit_selected FROM vacancies v
    JOIN prefilter_scores p ON p.user_id=? AND p.vacancy_id=v.id
    LEFT JOIN scores s ON s.user_id=? AND s.vacancy_id=v.id
    JOIN user_vacancies uv ON uv.user_id=? AND uv.vacancy_id=v.id
    WHERE s.vacancy_id IS NULL AND uv.decision NOT IN ('skipped','applied') AND p.context_hash=?
      AND p.content_hash=v.content_hash AND p.filtered=? ${filtered ? 'AND p.audit_selected<>0' : ''}
    ORDER BY p.combined_score DESC,v.published_at DESC LIMIT ?`)
    .all(userId, userId, userId, contextHash, Number(filtered), queryLimit));
  const audit = query(true, Math.min(limit, auditSlots));
  return [...query(false, Math.max(0, limit - audit.length)), ...audit];
}
export function prefilterQueueStats(userId: string, contextHash: string): { queued: number; filtered: number; auditQueued: number } {
  const row = db.prepare(`SELECT COALESCE(SUM(CASE WHEN p.filtered=0 THEN 1 ELSE 0 END),0) queued,
    COALESCE(SUM(CASE WHEN p.filtered<>0 THEN 1 ELSE 0 END),0) filtered,
    COALESCE(SUM(CASE WHEN p.filtered<>0 AND p.audit_selected<>0 THEN 1 ELSE 0 END),0) audit_queued
    FROM prefilter_scores p LEFT JOIN scores s ON s.user_id=p.user_id AND s.vacancy_id=p.vacancy_id
    WHERE p.user_id=? AND p.context_hash=? AND p.content_hash=(SELECT content_hash FROM vacancies WHERE id=p.vacancy_id)
    AND s.vacancy_id IS NULL`).get(userId, contextHash);
  return { queued: Number(row?.queued ?? 0), filtered: Number(row?.filtered ?? 0), auditQueued: Number(row?.audit_queued ?? 0) };
}
export interface PrefilterCalibration { compared: number; correlation: number | null; audited: number; auditFalseNegatives: number; applied: number; skipped: number; feedbackLabels: number; readyForAdjustment: boolean }
export function prefilterCalibration(userId: string, contextHash: string, alertScore: number, minimumLabels: number): PrefilterCalibration {
  const rows = db.prepare(`SELECT p.combined_score,p.filtered,p.audit_selected,s.score,s.hard_rejection,uv.decision
    FROM prefilter_scores p JOIN scores s ON s.user_id=p.user_id AND s.vacancy_id=p.vacancy_id
    JOIN vacancies v ON v.id=p.vacancy_id JOIN user_vacancies uv ON uv.user_id=p.user_id AND uv.vacancy_id=p.vacancy_id
    WHERE p.user_id=? AND p.context_hash=? AND p.content_hash=v.content_hash`).all(userId, contextHash);
  const compared = rows.length; let sumX=0,sumY=0,sumXY=0,sumXX=0,sumYY=0,audited=0,auditFalseNegatives=0,applied=0,skipped=0;
  for (const row of rows) {
    const x=Number(row.combined_score),y=Number(row.score); sumX+=x;sumY+=y;sumXY+=x*y;sumXX+=x*x;sumYY+=y*y;
    if (row.audit_selected) { audited++; if (y>=alertScore && !row.hard_rejection) auditFalseNegatives++; }
    if (row.decision==='applied'||row.decision==='applying') applied++; if (row.decision==='skipped') skipped++;
  }
  const denominator=Math.sqrt((compared*sumXX-sumX*sumX)*(compared*sumYY-sumY*sumY));
  const correlation=compared>=2&&denominator?(compared*sumXY-sumX*sumY)/denominator:null; const feedbackLabels=applied+skipped;
  return { compared,correlation,audited,auditFalseNegatives,applied,skipped,feedbackLabels,readyForAdjustment:feedbackLabels>=minimumLabels };
}

export function saveScore(userId: string, vacancyId: number, score: number, primaryTrack: string, summary: string, reasons: string[], gaps: string[], hardRejection: boolean): void {
  if (!hasCompleteCv(userId)) throw new Error('Both CV templates are required.');
  ensureUserVacancy(userId, vacancyId);
  db.prepare(`INSERT INTO scores(user_id,vacancy_id,score,primary_track,summary,reasons_json,gaps_json,hard_rejection,scored_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,vacancy_id) DO UPDATE SET score=excluded.score,primary_track=excluded.primary_track,
    summary=excluded.summary,reasons_json=excluded.reasons_json,gaps_json=excluded.gaps_json,hard_rejection=excluded.hard_rejection,
    scored_at=excluded.scored_at,alert_sent_at=NULL,digest_sent_at=NULL`)
    .run(userId, vacancyId, score, primaryTrack, summary, JSON.stringify(reasons), JSON.stringify(gaps), Number(hardRejection), new Date().toISOString());
}
export interface ScoredVacancy extends Vacancy { userId: string; score: number; primaryTrack: string; summary: string; reasons: string[]; gaps: string[]; hardRejection: boolean }
function rowToScoredVacancy(row: Record<string, unknown>): ScoredVacancy {
  return { ...rowToVacancy(row), userId: String(row.score_user_id ?? row.user_id), score: Number(row.score),
    primaryTrack: String(row.primary_track), summary: String(row.summary), reasons: JSON.parse(String(row.reasons_json)) as string[],
    gaps: JSON.parse(String(row.gaps_json)) as string[], hardRejection: Boolean(row.hard_rejection) };
}
const scoredSelect = `SELECT v.*,uv.decision user_decision,s.user_id score_user_id,s.score,s.primary_track,s.summary,
  s.reasons_json,s.gaps_json,s.hard_rejection FROM vacancies v JOIN scores s ON s.vacancy_id=v.id
  JOIN user_vacancies uv ON uv.user_id=s.user_id AND uv.vacancy_id=v.id`;
export function getScoredVacancy(userId: string, id: number): ScoredVacancy | null {
  const row = db.prepare(`${scoredSelect} WHERE s.user_id=? AND v.id=?`).get(userId, id); return row ? rowToScoredVacancy(row) : null;
}
export function getScoredVacancyByApplyId(userId: string, applyId: string): ScoredVacancy | null {
  const row = db.prepare(`${scoredSelect} WHERE s.user_id=? AND v.apply_id=?`).get(userId, applyId); return row ? rowToScoredVacancy(row) : null;
}
export function searchScoredVacancies(userId: string, input: string, limit = 10): ScoredVacancy[] {
  const tokens = input.toLowerCase().match(/[\p{L}\p{N}+#.]{2,}/gu)?.slice(0, 12) ?? [];
  if (!tokens.length) return [];
  const query = tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(' AND ');
  return db.prepare(`${scoredSelect} JOIN vacancies_fts f ON f.rowid=v.id
    WHERE s.user_id=? AND vacancies_fts MATCH ? ORDER BY bm25(vacancies_fts),s.score DESC LIMIT ?`)
    .all(userId, query, Math.max(1, Math.min(limit, 30))).map(rowToScoredVacancy);
}
export function latestDigestVacanciesByApplyIdPrefix(userId: string, prefix: string): ScoredVacancy[] {
  return db.prepare(`${scoredSelect} WHERE s.user_id=? AND s.digest_sent_at=(SELECT MAX(digest_sent_at) FROM scores WHERE user_id=? AND digest_sent_at IS NOT NULL)
    AND v.apply_id LIKE ? ORDER BY s.score DESC,v.published_at DESC LIMIT 2`).all(userId, userId, `${prefix}%`).map(rowToScoredVacancy);
}
export function digestVacancies(userId: string, min: number, high: number, limit=30): ScoredVacancy[] {
  return db.prepare(`${scoredSelect} WHERE s.user_id=? AND s.score>=? AND s.score<? AND s.digest_sent_at IS NULL
    AND uv.decision NOT IN ('skipped','applying','applied') ORDER BY s.score DESC,v.published_at DESC LIMIT ?`)
    .all(userId,min,high,limit).map(rowToScoredVacancy);
}
export function unsentHighScoreVacancies(userId: string, minScore: number, limit=30): ScoredVacancy[] {
  return db.prepare(`${scoredSelect} WHERE s.user_id=? AND s.score>=? AND s.hard_rejection=0 AND s.alert_sent_at IS NULL
    AND uv.decision NOT IN ('skipped','applying','applied') ORDER BY s.score DESC,v.published_at DESC LIMIT ?`)
    .all(userId,minScore,limit).map(rowToScoredVacancy);
}
export function markAlerted(userId: string, id: number): void {
  const now=new Date().toISOString(); db.prepare('UPDATE scores SET alert_sent_at=? WHERE user_id=? AND vacancy_id=?').run(now,userId,id);
  db.prepare("UPDATE user_vacancies SET decision='alerted',updated_at=? WHERE user_id=? AND vacancy_id=? AND decision='new'").run(now,userId,id);
}
export function markDigested(userId: string, ids: number[]): void {
  const now=new Date().toISOString(); for (const id of ids) {
    db.prepare('UPDATE scores SET digest_sent_at=? WHERE user_id=? AND vacancy_id=?').run(now,userId,id);
    db.prepare("UPDATE user_vacancies SET decision='digested',updated_at=? WHERE user_id=? AND vacancy_id=? AND decision='new'").run(now,userId,id);
  }
}
export function skipVacancy(userId: string, id: number): void {
  ensureUserVacancy(userId,id); db.prepare("UPDATE user_vacancies SET decision='skipped',updated_at=? WHERE user_id=? AND vacancy_id=?")
    .run(new Date().toISOString(),userId,id);
}
export function beginApplication(userId: string, id: number): void {
  ensureUserVacancy(userId,id); const now=new Date().toISOString();
  db.prepare(`INSERT INTO applications(user_id,vacancy_id,status,requested_at,updated_at) VALUES (?,?,'generating',?,?)
    ON CONFLICT(user_id,vacancy_id) DO UPDATE SET status='generating',error=NULL,updated_at=excluded.updated_at`).run(userId,id,now,now);
  db.prepare("UPDATE user_vacancies SET decision='applying',updated_at=? WHERE user_id=? AND vacancy_id=?").run(now,userId,id);
}
export function markApplicationReady(userId: string, id: number): void {
  db.prepare("UPDATE applications SET status='ready',updated_at=? WHERE user_id=? AND vacancy_id=?").run(new Date().toISOString(),userId,id);
}
export function markApplicationDelivered(userId: string, id: number): void {
  db.prepare("UPDATE user_vacancies SET decision='applied',updated_at=? WHERE user_id=? AND vacancy_id=?")
    .run(new Date().toISOString(),userId,id);
}
export function failApplication(userId: string, id: number, error: string): void {
  const now=new Date().toISOString();
  db.prepare("UPDATE applications SET status='failed',error=?,updated_at=? WHERE user_id=? AND vacancy_id=?").run(error,now,userId,id);
  db.prepare("UPDATE user_vacancies SET decision='alerted',updated_at=? WHERE user_id=? AND vacancy_id=?").run(now,userId,id);
}
