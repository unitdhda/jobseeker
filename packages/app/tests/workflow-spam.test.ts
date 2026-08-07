import assert from 'node:assert/strict';
import test from 'node:test';
import { userWorkflowBusyMessage, type UserWorkflowKind } from '../src/telegram/workflow-lock.ts';

const kinds: UserWorkflowKind[] = ['cv-import', 'profile-refresh', 'tailored-cv', 'cover-letter'];

test('every expensive user workflow produces an explicit non-queued busy notice', () => {
  for (const activeKind of kinds) {
    for (const requestedKind of kinds) {
      const message = userWorkflowBusyMessage({ token: 'test', kind: activeKind, startedAt: new Date(0).toISOString() }, requestedKind, 'ru');
      assert.match(message, /Сейчас уже выполняется/);
      assert.match(message, /не запущен/);
      assert.match(message, /не ставятся в очередь/);
      assert.match(message, /не запускают дополнительные обращения к языковой модели/);
      assert.match(message, /Дождитесь итогового сообщения/);
    }
  }
});

test('a malformed or stale workflow state still gives a safe generic notice', () => {
  const message = userWorkflowBusyMessage(null, 'cover-letter', 'ru');
  assert.match(message, /другая операция с резюме или документами/);
  assert.match(message, /сопроводительного письма/);
});
