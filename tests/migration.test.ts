import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

test('legacy single-user CV storage migrates to owner-scoped reusable text', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jobseeker-migration-test-'));
  const path = join(directory, 'legacy.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE cv_templates(language TEXT PRIMARY KEY,cv_path TEXT NOT NULL,cv_sha256 TEXT NOT NULL,
    cv_text TEXT NOT NULL,updated_at TEXT NOT NULL);
    INSERT INTO cv_templates VALUES ('ru','/private/ru.pdf','hash','Legacy reusable CV text with substantial experience, skills, education, achievements, languages, and contact details.','2026');`);
  legacy.close();
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
    "await import('./src/lib/database.ts')"], { cwd: process.cwd(), env: { ...process.env,
      DATABASE_PATH: path, TELEGRAM_USER_ID: '1001', TELEGRAM_CHAT_ID: '1001', RUN_JOBS: 'false', TELEGRAM_POLLING: 'false' } });
  const migrated = new DatabaseSync(path, { readOnly: true });
  const columns = migrated.prepare('PRAGMA table_info(cv_templates)').all().map((row) => String(row.name));
  assert.equal(columns.includes('cv_path'), false);
  assert.equal(columns.includes('document_json'), true);
  const cv = migrated.prepare("SELECT user_id,source_format,document_json FROM cv_templates WHERE language='ru'").get();
  assert.equal(String(cv?.user_id), '1001');
  assert.equal(String(cv?.source_format), 'pdf');
  assert.ok((JSON.parse(String(cv?.document_json)) as { blocks: unknown[] }).blocks.length > 0);
  migrated.close();
  rmSync(directory, { recursive: true, force: true });
});
