import { start } from '@flue/runtime/node';
import db from '../db.ts';
import { PrepareSearchProfile, ScoreVacancies, TailorApplication } from '../agents/workflows.ts';

export function startScriptRuntime() {
  return start({ agents: [PrepareSearchProfile, ScoreVacancies, TailorApplication], db });
}
