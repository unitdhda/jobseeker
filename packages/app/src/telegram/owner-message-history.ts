import type { UserId } from '@jobseeker/engine/contracts';

export interface OwnerMessageHistory {
  begin(userId: UserId, commandMessageId?: number): Promise<number>;
  record(userId: UserId, generation: number, answerMessageId: number): void;
}

export function createOwnerMessageHistory(deleteMessage: (userId: UserId, messageId: number) => Promise<void>): OwnerMessageHistory {
  const sessions = new Map<UserId, { generation: number; messageIds: number[] }>();
  let nextGeneration = 0;
  return Object.freeze({
    async begin(userId: UserId, commandMessageId?: number): Promise<number> {
      const previous = sessions.get(userId);
      const generation = ++nextGeneration;
      sessions.set(userId, { generation, messageIds: commandMessageId === undefined ? [] : [commandMessageId] });
      if (previous) {
        for (const messageId of new Set(previous.messageIds)) await deleteMessage(userId, messageId).catch(() => undefined);
      }
      return generation;
    },
    record(userId: UserId, generation: number, answerMessageId: number): void {
      const session = sessions.get(userId);
      if (session?.generation === generation) session.messageIds.push(answerMessageId);
    },
  });
}
