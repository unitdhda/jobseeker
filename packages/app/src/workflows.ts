import { createHash } from 'node:crypto';
import { generateJson } from './ai.ts';
import { config } from './config.ts';
import {
  applicationAgents, beginApplication, claimForScoring, failApplication, getCvHash, getCvSource, getScoredVacancy,
  getSearchProfile, getVacancy, markApplicationReady, recordUsage, requireApprovedUser, saveScore, saveSearchProfile,
  transitionMatch, usageInLast24Hours, type ApplicationArtifact, type Vacancy,
} from './postgres.ts';
import { enabledSourceProviderIds, getSearchPlatform, platformSearches } from './vacancies/registry.ts';
import { compileDemand, type DemandInput } from '@jobseeker/engine';
import { roleTokenResolver, tryRefreshRoleEquivalences } from './role-equivalence.ts';
import { backfillUserMatches } from './matching.ts';
import { activeUnitQueries, applyDemand, existingCompiledUnits } from './postgres.ts';
import * as v from 'valibot';
import { clearApplicationArtifacts, stageApplicationArtifacts, type GeneratedApplication } from './documents.ts';
import { cvDocumentLimits, cvDocumentSchema, normalizeCvDocumentJson, parseCvText } from '@jobseeker/cv/pdf';
import { trace } from './observability.ts';
import { errorMessage } from './observability.ts';
import { adaptiveConcurrency, AdaptiveTaskPool } from '@jobseeker/engine/concurrency';
import {
  careerProfileLimits, careerProfilePlatformId, careerProfileSchema, normalizeCareerProfileJson,
  parseStoredCareerProfile, vacancyRecency,
  type CareerProfile, type StoredCareerProfile,
} from '@jobseeker/engine';
import { compileCvDocument } from './documents.ts';
import { detectCvLanguage } from './cv.ts';

const scoringPool = new AdaptiveTaskPool(config.scoreAgentConcurrencyMin, config.scoreAgentConcurrencyMax);
const vacancyScoreSchema=v.object({vacancyId:v.pipe(v.number(),v.integer(),v.minValue(1)),score:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(100)),
  primaryTrack:v.pipe(v.string(),v.minLength(1),v.maxLength(200)),summary:v.pipe(v.string(),v.minLength(5),v.maxLength(1_000)),
  reasons:v.pipe(v.array(v.pipe(v.string(),v.minLength(2),v.maxLength(500))),v.maxLength(10)),
  gaps:v.pipe(v.array(v.pipe(v.string(),v.minLength(2),v.maxLength(500))),v.maxLength(10)),hardRejection:v.boolean()});
const vacancyScoresSchema=v.pipe(v.array(vacancyScoreSchema),v.minLength(1),v.maxLength(20));
const scoringResultSchema=v.union([v.object({scores:vacancyScoresSchema}),vacancyScoresSchema]);
const tailoredCvTextSchema=v.pipe(v.string(),v.minLength(500),v.maxLength(30_000));
// Three short paragraphs land well under this; the cap is what stops a model that ignored the instruction, since
// the letters were arriving far too long to read.
const coverLetterSchema=v.pipe(v.string(),v.minLength(80),v.maxLength(2_000));
/**
 * The CV is requested as structured blocks so the layout never has to infer what a line meant. `tailoredCvText`
 * remains accepted because a model that regresses to prose should still produce a PDF; it is parsed back into the
 * same document.
 */
export const cvResultSchema=v.pipe(
  v.looseObject({cv:v.optional(cvDocumentSchema),tailoredCvText:v.optional(tailoredCvTextSchema)}),
  v.transform(result=>({cv:result.cv??null,tailoredCvText:result.tailoredCvText??null})),
  v.check(result=>result.cv!=null||result.tailoredCvText!=null,'Expected a cv object of structured blocks.'),
);

/** `coverLetterText` is a long-standing alias the models keep reaching for. */
export const coverLetterResultSchema=v.pipe(
  v.looseObject({coverLetter:v.optional(coverLetterSchema),coverLetterText:v.optional(coverLetterSchema)}),
  v.transform(result=>({coverLetter:result.coverLetter??result.coverLetterText??''})),
  v.check(result=>result.coverLetter.length>=80,'Expected a coverLetter of at least 80 characters.'),
);

/**
 * The caps are spelled out because the schema is strict and the agent cannot see it: a track carrying thirteen
 * evidence lines failed a user's whole profile refresh in production, twice over, before the local repair caught
 * it. The numbers interpolate from the schema's own `careerProfileLimits`, so the two cannot drift apart.
 */
export const careerProfileSystemPrompt=`Derive occupation-neutral career tracks solely from explicit CV evidence. Never use a fixed
occupation or industry taxonomy. Return exactly {"version":1,"tracks":[{"name":"...","titleVariants":["..."],
"coreSkills":["..."],"evidence":["..."]}]}. The root key is tracks, never careerTracks. Add no other field.
Each titleVariants item is one title in one language; Russian and English translations must be separate items.
Translation must not broaden the occupation.
Contact details, employer technologies and project names are not candidate skills. Do not invent adjacent occupations.
These array limits are strict and a response that exceeds any of them is rejected in full: 1-${
  careerProfileLimits.tracks} tracks, 1-${careerProfileLimits.titleVariants}
titleVariants, at most ${careerProfileLimits.coreSkills} coreSkills, and 1-${
  careerProfileLimits.evidence} evidence items per track. Select the strongest few rather than listing
everything the CV supports. Every name, titleVariants and coreSkills item is 2-100 characters; every evidence item is
2-300 characters.`;

async function ensureCareerProfile(userId: string, cvText: string, cvHash: string, force: boolean): Promise<CareerProfile> {
  const existing = parseStoredCareerProfile(
    await getSearchProfile<StoredCareerProfile>(userId, careerProfilePlatformId), cvHash,
  );
  if (!force && existing) return existing;
  const generated=await generateJson({userId,agent:'prepare-career-profile',model:config.model,thinking:config.thinkingLevel,
    schema:careerProfileSchema,system:careerProfileSystemPrompt,
    prompt:`Authoritative CV source:\n\n${cvText}`,repair:normalizeCareerProfileJson});
  if(await getCvHash(userId)!==cvHash)throw new Error('CV changed during career-profile generation.');
  await saveSearchProfile(userId,careerProfilePlatformId,{cvHash,profile:generated});
  return generated;
}

export async function ensureCvAndSearchProfiles(userId: string, force = false,
  expectedCvHash?: string): Promise<Record<string, unknown>> {
  await requireApprovedUser(userId);
  const cv = await getCvSource(userId);
  if (!cv) throw new Error('Upload one authoritative CV source with /cv first.');
  const hash = await getCvHash(userId);
  if (!hash || (expectedCvHash && hash !== expectedCvHash)) throw new Error('CV changed before profile generation started.');
  await ensureCareerProfile(userId, cv.cvText, hash, force);
  const profiles: Record<string, unknown> = {};

  for (const platformId of enabledSourceProviderIds) {
    await requireApprovedUser(userId);
    if (await getCvHash(userId) !== hash) throw new Error('CV changed during profile generation.');
    const platform = getSearchPlatform(platformId);
    try {
      if (force || !await getSearchProfile(userId, platformId)) {
        if (await usageInLast24Hours(userId, 'search-profile') >= config.userDailySearchProfileLimit) {
          throw new Error(`Daily search-profile limit (${config.userDailySearchProfileLimit}) reached.`);
        }
        trace('search_profile.agent.start', { userId, platform: platformId, force });
        const careerProfile=parseStoredCareerProfile(await getSearchProfile<StoredCareerProfile>(userId,careerProfilePlatformId),hash);
        if(!careerProfile)throw new Error('A current career profile is required.');
        await recordUsage(userId,'search-profile');
        const generated=await generateJson({userId,agent:'prepare-search-profile',model:config.model,thinking:config.thinkingLevel,
          schema:platform.schema,system:`Build a validated vacancy-search profile only from CV-derived career tracks and the supplied
platform capabilities. Never assume a software or technology sector. For a constrained platform, return an empty searches
array when no supported category credibly matches. Translate evidenced role terminology when required without adding adjacent roles.`,
          prompt:`PLATFORM CAPABILITIES:\n${JSON.stringify(platform.template())}\n\nCAREER PROFILE:\n${JSON.stringify(careerProfile)}`
            +existingUnitsAdvisory(await activeUnitQueries(platformId))
            +`\n\nCV SOURCE:\n${cv.cvText}`});
        if(await getCvHash(userId)!==hash)throw new Error('CV changed during profile generation.');
        await saveSearchProfile(userId,platformId,generated);
        trace('search_profile.agent.completed',{platform:platformId});
      }

      const result = v.safeParse(platform.schema, await getSearchProfile<unknown>(userId, platformId));
      if (!result.success) throw new Error(`Search-profile agent did not save a valid ${platform.name} profile.`);
      profiles[platformId] = result.output;
      trace('search_profile.ready', { platform: platformId, profile: result.output });
    } catch (error) {
      console.error(`Failed to prepare ${platform.name} search profile: ${errorMessage(error)}`);
    }
  }
  await compileUserDemand(userId);
  return profiles;
}

/**
 * Profiles are wishes; units are the schedule. Whatever the searches now say replaces the user's subscriptions:
 * new demand mints or adopts units, vanished demand retires the units nobody else holds. Without this step a saved
 * profile would never be searched, so a compilation failure is a real failure, not a logging event.
 */
const advisoryUnitLimit = 30;
/**
 * Shows profile generation the search wordings already running on the platform, so equivalent demand converges on
 * existing units instead of minting near-duplicates. Advisory and content-only: reuse is only ever suggested when
 * CV fit is equal, and nothing about who runs a search leaves the store.
 */
export function existingUnitsAdvisory(queries: readonly unknown[], limit = advisoryUnitLimit): string {
  const wordings = queries.map((query) => {
    const record = (query ?? {}) as Record<string, unknown>;
    const value = [record.text, record.query, record.specialization].find(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
    return value?.trim() ?? '';
  }).filter(Boolean);
  const unique = [...new Set(wordings)].slice(0, limit);
  if (!unique.length) return '';
  return `\n\nEXISTING SEARCHES ALREADY RUNNING ON THIS PLATFORM (advisory only):\n${JSON.stringify(unique)}\n`
    + 'When an existing wording fits the evidenced career tracks equally well, reuse it exactly so equivalent '
    + 'searches converge. Never trade CV fit for reuse; ignore entries that do not match the CV.';
}

export async function compileUserDemand(userId: string): Promise<{ units: number; subscriptions: number }> {
  const demands: DemandInput[] = [];
  for (const platformId of enabledSourceProviderIds) {
    const profile = await getSearchProfile<unknown>(userId, platformId);
    if (!profile) continue;
    try {
      const searches = platformSearches(platformId, profile);
      if (searches.length) demands.push({ userId, platform: platformId, searches });
    } catch (error) {
      console.error(`Skipping ${platformId} demand for user ${userId}: ${errorMessage(error)}`);
    }
  }
  // Adoption consults the learned vocabulary so бухгалтер and accountant land in one unit; identity hashing does not.
  const compiled = compileDemand(demands, config.searchClusterSimilarity / 100, await existingCompiledUnits(),
    roleTokenResolver());
  await applyDemand(userId, compiled.units, compiled.subscriptions, config.unitCadenceFloorMinutes);
  // A fresh profile may carry vocabulary no other user has; mine it now so this user's matching starts warm.
  await tryRefreshRoleEquivalences();
  // Match-on-ingest never revisits the past: the new lens judges the recent normalized stock here, once, so a
  // fresh user's first digest draws on everything already discovered instead of starting from zero.
  const backfilled = await backfillUserMatches(userId).catch((error) => {
    console.error(`Match backfill failed for user ${userId}: ${errorMessage(error)}`);
    return 0;
  });
  trace('demand.compiled', { userId, minted: compiled.units.length, subscriptions: compiled.subscriptions.length,
    backfilled });
  return { units: compiled.units.length, subscriptions: compiled.subscriptions.length };
}

export async function missingSearchProfiles(userId:string):Promise<string[]>{
  const cv=await getCvSource(userId);if(!cv)return[careerProfilePlatformId,...enabledSourceProviderIds];
  const missing:string[]=[];
  const career=parseStoredCareerProfile(await getSearchProfile<StoredCareerProfile>(userId,careerProfilePlatformId),cv.cvSha256);
  if(!career)missing.push(careerProfilePlatformId);
  for(const platformId of enabledSourceProviderIds){
    const platform=getSearchPlatform(platformId),profile=await getSearchProfile<unknown>(userId,platformId);
    if(!v.safeParse(platform.schema,profile).success)missing.push(platformId);
  }
  return missing;
}

let scoringSubscriptionUnavailableUntil = 0;

function subscriptionLimitText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof Error) {
      parts.push(current.name, current.message);
      current = current.cause;
    } else if (typeof current === 'object') {
      const value = current as Record<string, unknown>;
      for (const key of ['code', 'type', 'message', 'details']) {
        if (typeof value[key] === 'string') parts.push(value[key]);
      }
      current = value.cause;
    } else { parts.push(String(current)); break; }
  }
  return parts.join(' ');
}

function isSubscriptionUsageLimit(error: unknown): boolean {
  return /ChatGPT usage limit|usage_limit_reached|usage_not_included|GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached/i
    .test(subscriptionLimitText(error));
}

function fallbackDuration(error: unknown): number {
  const minutes = Number(/try again in ~?(\d+) min/i.exec(subscriptionLimitText(error))?.[1] ?? 60);
  return Math.max(15, Math.min(Number.isFinite(minutes) ? minutes + 2 : 60, 24 * 60)) * 60_000;
}

function scoringApiFallbackConfigured(): boolean {
  return Boolean(config.scoringFallbackModel);
}

async function dispatchScoringBatch(userId: string, vacancies: Vacancy[], provider: 'subscription' | 'api',
  signal:AbortSignal): Promise<void> {
  const cv=await getCvSource(userId);if(!cv)throw new Error('The authoritative CV source was not found.');
  const contexts=vacancies.map(vacancy=>{const recency=vacancyRecency(
    vacancy,Date.now(),config.prefilterMaxAgeDays);return{vacancyId:vacancy.id,
    language:detectCvLanguage(`${vacancy.name}\n${vacancy.description}`),
    source:vacancy.source,name:vacancy.name,employer:vacancy.employer,area:vacancy.area,salaryFrom:vacancy.salaryFrom,
    salaryTo:vacancy.salaryTo,salaryCurrency:vacancy.salaryCurrency,salaryGross:vacancy.salaryGross,experience:vacancy.experience,
    employment:vacancy.employment,schedule:vacancy.schedule,workFormat:vacancy.workFormat,
    age:recency.label,ageBand:recency.band,description:vacancy.description,keySkills:vacancy.keySkills};});
  const judge=provider==='api'?config.scoringFallbackModel:config.scoringModel;
  const result=await generateJson({userId,agent:'score-vacancies',model:judge,
    thinking:provider==='api'?config.scoringFallbackThinkingLevel:config.scoringThinkingLevel,schema:scoringResultSchema,
    system:`Score each CV-vacancy match independently. Use no fixed occupation taxonomy and never score keyword overlap without
role compatibility. Rubric: must-have skills 40, seniority/years 20, responsibilities 15, domain 10, location/work format 10,
compensation 5; missing salary is neutral. Penalize underqualification and substantial overqualification. An explicit hard
blocker sets hardRejection=true and caps score at 49.
The age field states how old the advert is, in bands, from the date the source published it. Fit decides the score; age
only separates otherwise comparable matches, and an advert several weeks old is worth noting as possibly filled. Return exactly one result for each vacancyId, at most three reasons and
at most three gaps. The JSON must be either
{"scores":[{"vacancyId":1,"score":0,"primaryTrack":"...","summary":"...","reasons":[],"gaps":[],"hardRejection":false}]}
or the same scores array directly. Use these exact field names and no additional wrapper.`, 
    prompt:`AUTHORITATIVE CV:\n${cv.cvText}\n\nVACANCIES:\n${JSON.stringify(contexts)}`,signal});
  const scores=Array.isArray(result)?result:result.scores;
  const expected=new Set(vacancies.map(vacancy=>vacancy.id)),received=new Set(scores.map(score=>score.vacancyId));
  if(scores.length!==expected.size||received.size!==expected.size||[...expected].some(id=>!received.has(id)))
    throw new Error('AI did not return exactly one score per vacancy.');
  for(const score of scores){if(score.hardRejection&&score.score>49)throw new Error(`Hard-rejected vacancy ${score.vacancyId} scored above 49.`);
    await saveScore(userId,score.vacancyId,score.score,score.primaryTrack.slice(0,80),score.summary.slice(0,300),
      score.reasons.slice(0,3).map(reason=>reason.slice(0,240)),score.gaps.slice(0,3).map(gap=>gap.slice(0,240)),score.hardRejection,judge??null);}
}

async function scoreBatchAttempt(userId:string,vacancies:Vacancy[],signal:AbortSignal):Promise<void>{
  if (Date.now() < scoringSubscriptionUnavailableUntil && scoringApiFallbackConfigured()) {
    await dispatchScoringBatch(userId, vacancies, 'api',signal);
    trace('scoring.agent.completed', { vacancyIds: vacancies.map((vacancy) => vacancy.id), provider: 'api-fallback' });
    return;
  }
  try {
    await dispatchScoringBatch(userId, vacancies, 'subscription',signal);
    trace('scoring.agent.completed', { vacancyIds: vacancies.map((vacancy) => vacancy.id), provider: 'subscription' });
  } catch (error) {
    if ((await Promise.all(vacancies.map((vacancy) => getScoredVacancy(userId, vacancy.id)))).every(Boolean)) {
      trace('scoring.agent.completed', { vacancyIds: vacancies.map((vacancy) => vacancy.id),
        provider: 'subscription', recoveredAfterFinalTurnError: true });
      return;
    }
    if (!isSubscriptionUsageLimit(error)) throw error;
    scoringSubscriptionUnavailableUntil = Date.now() + fallbackDuration(error);
    if (!scoringApiFallbackConfigured()) {
      throw new Error('Subscription scoring usage limit reached and AI_SCORING_FALLBACK_MODEL is not configured.',
        { cause: error });
    }
    console.warn(`Subscription scoring limit reached; falling back to ${config.scoringFallbackModel} for ${vacancies.length} vacancies.`);
    await dispatchScoringBatch(userId, vacancies, 'api',signal);
    trace('scoring.agent.completed', { vacancyIds: vacancies.map((vacancy) => vacancy.id), provider: 'api-fallback' });
  }
}

export async function scoreBatch(userId: string, vacancies: Vacancy[]): Promise<void> {
  await requireApprovedUser(userId);
  if (!vacancies.length) return;
  const vacancyIds=vacancies.map(vacancy=>vacancy.id),batch=`[${vacancyIds.join(',')}]`;
  trace('scoring.agent.start', { vacancyIds, sources: vacancies.map((vacancy) => vacancy.source), provider: config.scoringModel });
  for (const vacancy of vacancies) await recordUsage(userId, 'score');
  let lastError:unknown;
  for(let attempt=1;attempt<=config.scoringBatchMaxAttempts;attempt++){
    const started=Date.now(),controller=new AbortController();let timedOut=false;
    const deadline=setTimeout(()=>{timedOut=true;controller.abort(new Error(
      `Scoring batch exceeded ${config.scoringBatchTimeoutSeconds} seconds.`));},config.scoringBatchTimeoutSeconds*1_000);
    console.info(`Scoring batch start: user=${userId}, vacancies=${batch}, attempt=${attempt}/${config.scoringBatchMaxAttempts}.`);
    try{
      await scoreBatchAttempt(userId,vacancies,controller.signal);
      console.info(`Scoring batch finish: user=${userId}, vacancies=${batch}, attempt=${attempt}, durationMs=${Date.now()-started}.`);
      return;
    }catch(error){
      lastError=error;
      const detail=errorMessage(error);
      if(timedOut)console.warn(`Scoring batch timeout: user=${userId}, vacancies=${batch}, attempt=${attempt}, durationMs=${Date.now()-started}.`);
      else console.warn(`Scoring batch failure: user=${userId}, vacancies=${batch}, attempt=${attempt}: ${detail}`);
      if(attempt===config.scoringBatchMaxAttempts||/subscription usage limit reached/i.test(detail))throw error;
      console.info(`Scoring batch retry: user=${userId}, vacancies=${batch}, nextAttempt=${attempt+1}.`);
      await new Promise(resolve=>setTimeout(resolve,1_000*attempt));
    }finally{clearTimeout(deadline);}
  }
  throw lastError;
}

export interface ScorePendingResult{attempted:number;completed:number}
export async function scorePendingVacancies(
  userId: string,
  afterScore?: (vacancyId: number) => Promise<void>,
  progress?: (phase: 'filtering' | 'scoring', current: number, total: number) => void,
  scoreLimit = config.userScoreLimitPerCycle,
): Promise<ScorePendingResult> {
  // Matching already judged relevance at ingest; scoring drains the best claims. A claim that fails to score is
  // released back to 'matched' so the next drain can retry it — unless saveScore landed first, then the release
  // finds no 'queued' row and does nothing.
  const claimed = await claimForScoring(userId, scoreLimit);
  const vacancies: Vacancy[] = [];
  for (const vacancyId of claimed) {
    const vacancy = await getVacancy(vacancyId);
    if (vacancy) vacancies.push(vacancy);
  }
  trace('scoring.claimed', { userId, claimed: claimed.length });
  const batches: Vacancy[][] = [];
  for (let offset = 0; offset < vacancies.length; offset += config.scoreBatchSize) {
    batches.push(vacancies.slice(offset, offset + config.scoreBatchSize));
  }
  progress?.('scoring', 0, vacancies.length);
  trace('scoring.parallel.start', {
    vacancies: vacancies.length,
    batches: batches.length,
    batchSize: config.scoreBatchSize,
    localConcurrency: adaptiveConcurrency(batches.length, config.scoreAgentConcurrencyMin, config.scoreAgentConcurrencyMax),
    poolActive: scoringPool.activeCount,
    poolQueued: scoringPool.queuedCount,
  });
  let progressed = 0;let completed=0;
  await Promise.all(batches.map((batch) => scoringPool.run(async () => {
    try {
      await scoreBatch(userId, batch);completed+=batch.length;
      for (const vacancy of batch) await afterScore?.(vacancy.id);
    } catch (error) {
      console.error(`Failed to score vacancy batch [${batch.map((vacancy) => vacancy.id).join(',')}]: ${errorMessage(error)}`);
      for (const vacancy of batch) await transitionMatch(userId, vacancy.id, 'queued', 'matched').catch(() => false);
    } finally {
      progressed += batch.length;
      progress?.('scoring', progressed, vacancies.length);
    }
  })));
  trace('scoring.parallel.completed', { vacancies: vacancies.length, batches: batches.length });
  return {attempted:vacancies.length,completed};
}

/**
 * The block vocabulary is described by what each block means rather than by how it will look, because the model is
 * choosing structure and the template owns the typography. Anything the model puts in `meta` is set in the dates
 * column, which is why repeating dates in the title has to be ruled out explicitly.
 */
/** Shared by both contracts so the letter reads the same whether or not a CV was generated with it. */
const coverLetterRules=`The cover letter is plain text of at most three short paragraphs separated by blank lines: why this
role, the concrete overlap with evidenced experience, and a brief close. Keep it under 1500 characters. No Markdown,
headings, bullet points, salutation block or signature block. Name specific evidence rather than describing enthusiasm.`;

export const tailorSystemPrompt=`Create a tailored CV from authoritative evidence only. Preserve all employers,
dates, titles, metrics, skills, degrees, languages and contacts without invention or inflation. Translate faithfully into the
vacancy language when needed.

Return exactly {"cv":{...}} using that exact field name.

"cv" is {"name","headline","contacts":[...],"sections":[{"title","blocks":[...]}]}. "headline" is the target role in one
line. "contacts" holds one item per contact (location, email, telegram, links) and is laid out as a single row.
"title" is a short section label such as SUMMARY, EXPERIENCE, PROJECTS, SKILLS, EDUCATION, LANGUAGES.

Each block is exactly one of:
{"kind":"text","text":"..."} — a paragraph of prose.
{"kind":"bullets","items":["..."]} — achievements or responsibilities, one per item, no leading bullet character.
{"kind":"entry","title":"employer or institution","subtitle":"role or degree","meta":"dates, location","text":"optional
introduction","bullets":["..."]} — a dated record. Put every date in "meta" and never repeat it in "title" or "subtitle".
{"kind":"facts","items":[{"term":"group","detail":"comma-separated values"}]} — skills, tooling, languages.

Use "entry" for every job, and one "facts" block per skills section rather than many "text" blocks. Inside any string,
**bold** and *italic* are the only markup; no Markdown, HTML, Typst, code, headings or bullet characters. Do not style
section labels or add separator lines — the template does that.

These limits are strict and a response that exceeds any of them is rejected in full: at most ${
  cvDocumentLimits.contacts} contacts, ${cvDocumentLimits.sections} sections, ${
  cvDocumentLimits.blocksPerSection} blocks per section, ${cvDocumentLimits.bullets} items in a "bullets" or entry
"bullets" list, and ${cvDocumentLimits.facts} items in a "facts" block. Keep the most relevant contacts and merge
related skill groups rather than overrunning a limit.

Return no cover letter. It is requested separately.`;

/**
 * The letter-only contract, used once the day's document quota is spent. It repeats none of the CV block vocabulary
 * above, so the call that still has to happen is the cheap one.
 */
export const coverLetterSystemPrompt=`Write a cover letter for this vacancy from authoritative CV evidence only. Preserve
employers, dates, titles and metrics without invention or inflation. Write in the vacancy language.

Return exactly {"coverLetter":"..."} using that exact field name.

${coverLetterRules}`;

/**
 * One deliverable per call. A vacancy that cannot take a fresh CV may still be worth a letter, and the reverse, so
 * the two are requested separately, budgeted separately, and never generated for each other's sake.
 */
export async function tailorApplication(userId: string, vacancyId: number,
  artifact: ApplicationArtifact): Promise<GeneratedApplication> {
  await requireApprovedUser(userId);
  const limit = artifact === 'cv' ? config.userDailyApplicationLimit : config.userDailyCoverLetterLimit;
  // Usage is recorded on delivery, so this counts what the user actually received in the window.
  const delivered = await usageInLast24Hours(userId, 'application', applicationAgents[artifact]);
  if (delivered >= limit) {
    throw new Error(artifact === 'cv' ? `Daily tailored-CV limit (${limit}) reached.`
      : `Daily cover-letter limit (${limit}) reached.`);
  }
  const vacancy = await getScoredVacancy(userId, vacancyId);
  if (!vacancy) throw new Error(`Scored vacancy ${vacancyId} was not found for this user.`);
  clearApplicationArtifacts(userId, vacancyId);
  await beginApplication(userId, vacancyId);
  try {
    const cv=await getCvSource(userId);if(!cv)throw new Error('The authoritative CV source was not found.');
    const prompt=`CV DOCUMENT:\n${JSON.stringify(cv.document)}\n\nCV TEXT:\n${cv.cvText}\n\nVACANCY:\n${JSON.stringify(vacancy)}\n\nVACANCY LANGUAGE: ${detectCvLanguage(`${vacancy.name}\n${vacancy.description}`)}`;
    trace('application.start',{userId,vacancyId,artifact,delivered,limit});
    let application:GeneratedApplication;
    if(artifact==='cv'){
      const documents=await generateJson({userId,agent:applicationAgents.cv,model:config.model,thinking:config.thinkingLevel,
        schema:cvResultSchema,repair:normalizeCvDocumentJson,system:tailorSystemPrompt,prompt});
      const document=documents.cv??parseCvText(documents.tailoredCvText!);
      application={tailoredCvPdf:compileCvDocument(document),coverLetter:null};
    }else{
      const letter=await generateJson({userId,agent:applicationAgents.letter,model:config.model,thinking:config.thinkingLevel,
        schema:coverLetterResultSchema,system:coverLetterSystemPrompt,prompt});
      application={tailoredCvPdf:null,coverLetter:letter.coverLetter};
    }
    stageApplicationArtifacts(userId,vacancyId,application);await markApplicationReady(userId,vacancyId);return application;
  } catch (error) {
    clearApplicationArtifacts(userId, vacancyId);
    try { await failApplication(userId, vacancyId, error instanceof Error ? error.message : String(error)); }
    catch (statusError) { console.error(`Could not persist failed application status: ${errorMessage(statusError)}`); }
    throw error;
  }
}
