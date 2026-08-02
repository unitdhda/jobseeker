import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

function migrate(path: string): void {
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
    "await import('./src/lib/database.ts')"], { cwd: process.cwd(), env: { ...process.env,
      DATABASE_PATH: path, TELEGRAM_USER_ID: '1001', TELEGRAM_CHAT_ID: '1001', RUN_JOBS: 'false', TELEGRAM_POLLING: 'false' } });
}

test('legacy RU/EN CV storage collapses to one owner-scoped authoritative source', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jobseeker-migration-test-'));
  const path = join(directory, 'legacy.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE cv_templates(language TEXT PRIMARY KEY,cv_path TEXT NOT NULL,cv_sha256 TEXT NOT NULL,
    cv_text TEXT NOT NULL,updated_at TEXT NOT NULL);
    INSERT INTO cv_templates VALUES
      ('ru','/private/ru.pdf','ru-hash','Legacy Russian reusable CV text with substantial experience, skills, education, achievements, languages, and contact details.','2025'),
      ('en','/private/en.pdf','en-hash','Legacy English reusable CV text with substantial experience, skills, education, achievements, languages, and contact details.','2026');`);
  legacy.close();
  migrate(path);
  const migrated = new DatabaseSync(path, { readOnly: true });
  const columns = migrated.prepare('PRAGMA table_info(cv_templates)').all().map((row) => String(row.name));
  assert.equal(columns.includes('cv_path'), false);
  assert.equal(columns.includes('document_json'), true);
  assert.equal(columns.includes('language'), false);
  assert.equal(columns.includes('source_language'), false);
  assert.equal(Number(migrated.prepare('SELECT COUNT(*) count FROM cv_templates').get()?.count), 1);
  const cv = migrated.prepare('SELECT user_id,cv_sha256,source_format,document_json FROM cv_templates').get();
  assert.equal(String(cv?.user_id), '1001');
  assert.equal(String(cv?.cv_sha256), 'en-hash');
  assert.equal(String(cv?.source_format), 'pdf');
  assert.ok((JSON.parse(String(cv?.document_json)) as { blocks: unknown[] }).blocks.length > 0);
  migrated.close();
  rmSync(directory, { recursive: true, force: true });
});

test('detailed scores migrate to numeric scores plus pending alert details', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jobseeker-score-migration-test-'));
  const path = join(directory, 'scores.db');
  migrate(path);
  const old = new DatabaseSync(path);
  old.exec(`INSERT INTO vacancies
      (hh_id,source,source_id,apply_id,name,employer,area,salary_from,salary_to,salary_currency,salary_gross,
       experience,employment,schedule,work_format,description,key_skills_json,url,published_at,source_query,content_hash,
       canonical_fingerprint,decision,first_seen_at,updated_at)
    VALUES ('legacy-score','hh','legacy-score','abcdef','Engineer','Employer','Remote',NULL,NULL,NULL,NULL,
      'senior','full','full','remote','TypeScript systems','["TypeScript"]','https://hh.ru/vacancy/123','2026','systems',
      'legacy-score-hash',NULL,'new','2026','2026');
    INSERT INTO user_vacancies(user_id,vacancy_id,decision,first_relevant_at,updated_at)
      SELECT '1001',id,'new','2026','2026' FROM vacancies WHERE source_id='legacy-score';
    DROP TABLE score_alert_details;
    DROP INDEX scores_user_score_idx;
    ALTER TABLE scores RENAME TO scores_minimal;
    CREATE TABLE scores (
      user_id TEXT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
      vacancy_id INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
      score INTEGER NOT NULL,primary_track TEXT NOT NULL,summary TEXT NOT NULL,reasons_json TEXT NOT NULL,
      gaps_json TEXT NOT NULL,hard_rejection INTEGER NOT NULL,scored_at TEXT NOT NULL,alert_sent_at TEXT,digest_sent_at TEXT,
      PRIMARY KEY(user_id,vacancy_id));
    INSERT INTO scores SELECT '1001',id,91,'Systems','Strong match','["TypeScript"]','["Scale"]',0,'2026',NULL,NULL
      FROM vacancies WHERE source_id='legacy-score';
    DROP TABLE scores_minimal;
    DELETE FROM app_migrations WHERE name='minimal-scores-v1';`);
  old.close();

  migrate(path);
  const migrated = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(migrated.prepare('PRAGMA table_info(scores)').all().map((row) => String(row.name)),
    ['user_id','vacancy_id','score']);
  assert.equal(Number(migrated.prepare('SELECT score FROM scores').get()?.score), 91);
  assert.equal(String(migrated.prepare('SELECT score_updated_at FROM user_vacancies').get()?.score_updated_at), '2026');
  assert.ok(migrated.prepare('PRAGMA table_info(user_delivery_windows)').all().some((row) => String(row.name) === 'digest_minutes'));
  const details = migrated.prepare('SELECT primary_track,summary,reasons_json,gaps_json FROM score_alert_details').get();
  assert.equal(String(details?.primary_track), 'Systems');
  assert.equal(String(details?.summary), 'Strong match');
  assert.deepEqual(JSON.parse(String(details?.reasons_json)), ['TypeScript']);
  migrated.close();
  rmSync(directory, { recursive: true, force: true });
});
