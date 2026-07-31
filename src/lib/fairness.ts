export interface FairUserBudget { userId: string; used: number; cycleUsed?: number; unlimited?: boolean }
export interface FairAllocation { userId: string; limit: number }

export function nextFairScoreRound(users: FairUserBudget[], remainingGlobalBudget: number,
  dailyLimit: number, perCycleLimit = 10): FairAllocation[] {
  let remaining = Math.max(0, Math.floor(remainingGlobalBudget));
  const allocations: FairAllocation[] = [];
  for (const user of users) {
    if (!remaining) break;
    const dailyBudget = user.unlimited ? remaining : Math.max(0, dailyLimit - user.used);
    const cycleBudget = Math.max(0, perCycleLimit - (user.cycleUsed ?? 0));
    const allowance = Math.min(dailyBudget, cycleBudget, remaining);
    if (!allowance) continue;
    allocations.push({ userId: user.userId, limit: allowance });
    remaining -= allowance;
  }
  return allocations;
}
