import { start } from '@flue/runtime/node';
import db from '../db.ts';
import { PrepareSearchProfile, ScoreVacancy, TailorApplication } from '../agents/workflows.ts';

export function startScriptRuntime() {
  return start({ agents: [PrepareSearchProfile, ScoreVacancy, TailorApplication], db });
}
