import { start } from '@flue/runtime/node';
import db from '../db.ts';
import { PrepareCareerProfile, PrepareSearchProfile, ScoreVacancies, TailorApplication } from '../agents/workflows.ts';

export function startScriptRuntime() {
  return start({ agents: [PrepareCareerProfile, PrepareSearchProfile, ScoreVacancies, TailorApplication], db });
}
