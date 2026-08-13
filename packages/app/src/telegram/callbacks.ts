import { parseUserId, type UserId } from '@jobseeker/engine/contracts';
import type { Locale, Store } from '@jobseeker/store';
import type { JobWorkerClient } from '../worker-client.ts';
import { confirmCvUpload, deliverApplicationArtifact, rejectCvUpload,
  type ApplicationActionPorts, type ApplicationTransport, type CvActionPorts } from './actions.ts';
import { onDemandDigest, type DeliveryPorts } from './delivery.ts';

export type TelegramCallback =
  | { readonly type: 'cv-confirm' }
  | { readonly type: 'cv-reject' }
  | { readonly type: 'digest'; readonly page: number }
  | { readonly type: 'apply'; readonly artifact: 'cv' | 'letter'; readonly vacancyId: number }
  | { readonly type: 'skip'; readonly vacancyId: number }
  | { readonly type: 'privacy-delete' };

function vacancyId(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new TypeError('Invalid callback vacancy ID.');
  const parsed = Number(value); if (!Number.isSafeInteger(parsed)) throw new RangeError('Callback vacancy ID is too large.');
  return parsed;
}
export function parseTelegramCallback(data: string): TelegramCallback {
  if (data === 'cv:confirm') return { type: 'cv-confirm' };
  if (data === 'cv:reject') return { type: 'cv-reject' };
  if (data === 'privacy:delete') return { type: 'privacy-delete' };
  let match = /^digest:(\d+)$/u.exec(data);
  if (match) { const page = Number(match[1]); if (!Number.isSafeInteger(page)) throw new RangeError('Invalid digest callback page.'); return { type: 'digest', page }; }
  match = /^apply:(cv|letter):([1-9]\d*)$/u.exec(data);
  if (match) return { type: 'apply', artifact: match[1] as 'cv' | 'letter', vacancyId: vacancyId(match[2]!) };
  match = /^skip:([1-9]\d*)$/u.exec(data);
  if (match) return { type: 'skip', vacancyId: vacancyId(match[1]!) };
  throw new TypeError('Invalid Telegram callback payload.');
}

export interface CallbackPorts {
  readonly store: Pick<Store, 'isApprovedUser' | 'skipVacancy' | 'deleteUserData'>;
  readonly cvActions: CvActionPorts;
  readonly applicationActions: ApplicationActionPorts;
  readonly worker: Pick<JobWorkerClient, 'request'>;
  readonly applicationTransport: ApplicationTransport;
  readonly delivery: DeliveryPorts;
  readonly digestMinScore: number;
  readonly alertScore: number;
}
export interface CallbackTransport {
  answer(text?: string): Promise<void>;
  edit(html: string): Promise<void>;
}

export async function routeTelegramCallback(input: { readonly data: string; readonly senderId: number; readonly locale: Locale;
  readonly ports: CallbackPorts; readonly transport: CallbackTransport }): Promise<'handled' | 'denied' | 'busy'> {
  const userId: UserId = parseUserId(String(input.senderId));
  if (!await input.ports.store.isApprovedUser(userId)) { await input.transport.answer('Access denied.'); return 'denied'; }
  const callback = parseTelegramCallback(input.data);
  switch (callback.type) {
    case 'cv-confirm':
      await input.transport.answer();
      await confirmCvUpload({ ports: input.ports.cvActions, worker: input.ports.worker, userId });
      return 'handled';
    case 'cv-reject':
      await input.transport.answer(); await rejectCvUpload(input.ports.cvActions, userId); return 'handled';
    case 'digest': {
      const page = await onDemandDigest({ userId, locale: input.locale, page: callback.page,
        minimumScore: input.ports.digestMinScore, alertScore: input.ports.alertScore, ports: input.ports.delivery });
      await input.transport.edit(page.html); await input.transport.answer(); return 'handled';
    }
    case 'apply': {
      const result = await deliverApplicationArtifact({ ports: input.ports.applicationActions, worker: input.ports.worker,
        transport: input.ports.applicationTransport, userId, vacancyId: callback.vacancyId, artifact: callback.artifact });
      await input.transport.answer(result === 'busy' ? 'Busy.' : undefined); return result === 'busy' ? 'busy' : 'handled';
    }
    case 'skip':
      await input.ports.store.skipVacancy(userId, callback.vacancyId); await input.transport.answer(); return 'handled';
    case 'privacy-delete':
      await input.ports.store.deleteUserData(userId); await input.transport.answer(); return 'handled';
  }
}
