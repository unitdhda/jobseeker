export interface FairUserBudget { userId: string; used: number; unlimited?: boolean }
export interface FairAllocation { userId: string; limit: number }

export function nextFairScoreRound(users: FairUserBudget[], remainingGlobalBudget: number,
  dailyLimit: number, quantum = 10): FairAllocation[] {
  let remaining = Math.max(0, Math.floor(remainingGlobalBudget));
  const allocations: FairAllocation[] = [];
  for (const user of users) {
    if (!remaining) break;
    const userBudget = user.unlimited ? remaining : Math.max(0, dailyLimit - user.used);
    const allowance = Math.min(userBudget, Math.max(1, quantum), remaining);
    if (!allowance) continue;
    allocations.push({ userId: user.userId, limit: allowance });
    remaining -= allowance;
  }
  return allocations;
}
