import { randomUUID } from 'node:crypto';
import {
  claimTelegramSession,
  getTelegramSession,
  releaseClaimedTelegramSession,
  updateClaimedTelegramSession,
} from '../telegram-state.ts';
import { errorMessage } from '../observability.ts';

export type UserWorkflowKind = 'cv-import' | 'profile-refresh' | 'tailored-cv' | 'cover-letter';
export interface UserWorkflowState { token: string; kind: UserWorkflowKind; startedAt: string }

const sessionKind = 'user-workflow';
const leaseTtlMs = 30 * 60_000;
const renewalIntervalMs = 5 * 60_000;

const workflowLabels: Record<UserWorkflowKind, string> = {
  'cv-import': 'загрузка и разбор резюме',
  'profile-refresh': 'подготовка поисковых настроек по резюме',
  'tailored-cv': 'подготовка адаптированного резюме',
  'cover-letter': 'подготовка сопроводительного письма',
};

function validState(value: unknown): value is UserWorkflowState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<UserWorkflowState>;
  return typeof state.token === 'string' && state.token.length > 0
    && typeof state.startedAt === 'string' && !Number.isNaN(Date.parse(state.startedAt))
    && typeof state.kind === 'string' && state.kind in workflowLabels;
}

export function userWorkflowBusyMessage(active: UserWorkflowState | null, requested: UserWorkflowKind): string {
  const activeLabel = active ? workflowLabels[active.kind] : 'другая операция с резюме или документами';
  const requestedLabel = workflowLabels[requested];
  return `Сейчас уже выполняется: «${activeLabel}». Запрос «${requestedLabel}» не запущен.\n\n`
    + 'Одновременно для одного пользователя выполняется только одна такая задача. Повторные нажатия не ставятся '
    + 'в очередь и не запускают дополнительные обращения к языковой модели. Дождитесь итогового сообщения об '
    + 'успехе или ошибке, затем повторите запрос.';
}

export class UserWorkflowLease {
  private state: UserWorkflowState;
  private released = false;
  private readonly renewal: ReturnType<typeof setInterval>;

  constructor(private readonly userId: string, state: UserWorkflowState) {
    this.state = state;
    this.renewal = setInterval(() => {
      void this.persist().catch((error) => console.warn(`Could not renew user workflow lease: ${errorMessage(error)}`));
    }, renewalIntervalMs);
    this.renewal.unref?.();
  }

  private async persist(): Promise<void> {
    if (this.released) return;
    const updated = await updateClaimedTelegramSession(this.userId, sessionKind, this.state.token, this.state, leaseTtlMs);
    if (!updated) throw new Error('User workflow lease was lost.');
  }

  async setKind(kind: UserWorkflowKind): Promise<void> {
    this.state = { ...this.state, kind };
    await this.persist();
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    clearInterval(this.renewal);
    await releaseClaimedTelegramSession(this.userId, sessionKind, this.state.token);
  }
}

export type UserWorkflowClaim =
  | { claimed: true; lease: UserWorkflowLease }
  | { claimed: false; active: UserWorkflowState | null };

export async function claimUserWorkflow(userId: string, kind: UserWorkflowKind): Promise<UserWorkflowClaim> {
  const state: UserWorkflowState = { token: randomUUID(), kind, startedAt: new Date().toISOString() };
  const result = await claimTelegramSession(userId, sessionKind, state, leaseTtlMs);
  if (result.claimed) return { claimed: true, lease: new UserWorkflowLease(userId, state) };
  return { claimed: false, active: validState(result.state) ? result.state : null };
}

export async function activeUserWorkflow(userId: string): Promise<UserWorkflowState | null> {
  const state = await getTelegramSession<unknown>(userId, sessionKind);
  return validState(state) ? state : null;
}
