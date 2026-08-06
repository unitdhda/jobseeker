// The store composition must run before any module touches a repository.
import './postgres.ts';
import { config } from './config.ts';
import { approvedUsers } from './postgres.ts';
import { closePostgresPool } from './postgres.ts';
import { mapConcurrent } from '@jobseeker/engine/concurrency';
import { ensureCvAndSearchProfiles, missingSearchProfiles } from './workflows.ts';
import { errorMessage } from './observability.ts';

const users=await approvedUsers(true);
const inspected=await mapConcurrent(users,config.userWorkflowConcurrency,async user=>({
  user,missing:await missingSearchProfiles(user.userId),
}));
const candidates=inspected.filter(result=>result.missing.length>0);
let completed=0,failed=0;
await mapConcurrent(candidates,config.userWorkflowConcurrency,async({user})=>{
  try{
    await ensureCvAndSearchProfiles(user.userId);
    const remaining=await missingSearchProfiles(user.userId);
    if(remaining.length)throw new Error(`${remaining.length} search profiles remain unavailable.`);
    completed++;
  }catch(error){
    failed++;
    console.error(`Profile refresh failed: ${errorMessage(error)}`);
  }
});
console.info(`Profile refresh complete: checked=${users.length}, eligible=${candidates.length}, completed=${completed}, failed=${failed}.`);
await closePostgresPool();
process.exit(failed?1:0);
