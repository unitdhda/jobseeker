import { createHash } from 'node:crypto';
import { generateJson } from './ai.ts';
import { config } from './config.ts';
import {
  beginApplication, failApplication, getCvHash, getCvSource, getScoredVacancy, getSearchProfile, markApplicationReady,
  pendingVacancies, prefilterCalibration, prefilterQueueStats, rankedPendingVacancies, recordUsage, requireApprovedUser,
  savePrefilterScore, saveScore, saveSearchProfile, usageInLast24Hours, vacanciesNeedingPrefilter, type Vacancy,
} from './database.ts';
import { getSearchPlatform } from './vacancies/registry.ts';
import * as v from 'valibot';
import { clearApplicationArtifacts, stageApplicationArtifacts, type GeneratedApplication } from './documents.ts';
import { trace } from './observability.ts';
import { prefilterVacancy } from './prefilter.ts';
import { errorMessage } from './observability.ts';
import { adaptiveConcurrency, AdaptiveTaskPool } from './concurrency.ts';
import {
  careerProfilePlatformId, careerProfileSchema, normalizeCareerProfileJson, parseStoredCareerProfile,
  type CareerProfile, type StoredCareerProfile,
} from './prefilter.ts';
import { compilePlainTextCv } from './documents.ts';
import { detectCvLanguage } from './cv.ts';

const scoringPool = new AdaptiveTaskPool(config.scoreAgentConcurrencyMin, config.scoreAgentConcurrencyMax);
const vacancyScoreSchema=v.object({vacancyId:v.pipe(v.number(),v.integer(),v.minValue(1)),score:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(100)),
  primaryTrack:v.pipe(v.string(),v.minLength(1),v.maxLength(200)),summary:v.pipe(v.string(),v.minLength(5),v.maxLength(1_000)),
  reasons:v.pipe(v.array(v.pipe(v.string(),v.minLength(2),v.maxLength(500))),v.maxLength(10)),
  gaps:v.pipe(v.array(v.pipe(v.string(),v.minLength(2),v.maxLength(500))),v.maxLength(10)),hardRejection:v.boolean()});
const vacancyScoresSchema=v.pipe(v.array(vacancyScoreSchema),v.minLength(1),v.maxLength(20));
const scoringResultSchema=v.union([v.object({scores:vacancyScoresSchema}),vacancyScoresSchema]);
const tailoredCvTextSchema=v.pipe(v.string(),v.minLength(500),v.maxLength(30_000));
const coverLetterSchema=v.pipe(v.string(),v.minLength(80),v.maxLength(3_500));
export const applicationResultSchema=v.union([
  v.object({tailoredCvText:tailoredCvTextSchema,coverLetter:coverLetterSchema}),
  v.pipe(v.object({tailoredCvText:tailoredCvTextSchema,coverLetterText:coverLetterSchema}),
    v.transform(result=>({tailoredCvText:result.tailoredCvText,coverLetter:result.coverLetterText}))),
]);

async function ensureCareerProfile(userId: string, cvText: string, cvHash: string, force: boolean): Promise<CareerProfile> {
  const existing = parseStoredCareerProfile(
    await getSearchProfile<StoredCareerProfile>(userId, careerProfilePlatformId), cvHash,
  );
  if (!force && existing) return existing;
  const generated=await generateJson({userId,agent:'prepare-career-profile',model:config.model,thinking:config.thinkingLevel,
    schema:careerProfileSchema,system:`Derive occupation-neutral career tracks solely from explicit CV evidence. Never use a fixed
occupation or industry taxonomy. Return exactly {"version":1,"tracks":[{"name":"...","titleVariants":["..."],
"coreSkills":["..."],"evidence":["..."]}]}. The root key is tracks, never careerTracks. Each titleVariants item is one title
in one language; Russian and English translations must be separate items. Translation must not broaden the occupation.
Contact details, employer technologies and project names are not candidate skills. Do not invent adjacent occupations.`,
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

  for (const platformId of config.searchPlatforms) {
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
          prompt:`PLATFORM CAPABILITIES:\n${JSON.stringify(platform.template())}\n\nCAREER PROFILE:\n${JSON.stringify(careerProfile)}\n\nCV SOURCE:\n${cv.cvText}`});
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
  return profiles;
}

export async function missingSearchProfiles(userId:string):Promise<string[]>{
  const cv=await getCvSource(userId);if(!cv)return[careerProfilePlatformId,...config.searchPlatforms];
  const missing:string[]=[];
  const career=parseStoredCareerProfile(await getSearchProfile<StoredCareerProfile>(userId,careerProfilePlatformId),cv.cvSha256);
  if(!career)missing.push(careerProfilePlatformId);
  for(const platformId of config.searchPlatforms){
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
  return Boolean(process.env.OPENAI_API_KEY);
}

async function dispatchScoringBatch(userId: string, vacancies: Vacancy[], provider: 'subscription' | 'api',
  signal:AbortSignal): Promise<void> {
  const cv=await getCvSource(userId);if(!cv)throw new Error('The authoritative CV source was not found.');
  const contexts=vacancies.map(vacancy=>({vacancyId:vacancy.id,language:detectCvLanguage(`${vacancy.name}\n${vacancy.description}`),
    source:vacancy.source,name:vacancy.name,employer:vacancy.employer,area:vacancy.area,salaryFrom:vacancy.salaryFrom,
    salaryTo:vacancy.salaryTo,salaryCurrency:vacancy.salaryCurrency,salaryGross:vacancy.salaryGross,experience:vacancy.experience,
    employment:vacancy.employment,schedule:vacancy.schedule,workFormat:vacancy.workFormat,description:vacancy.description,keySkills:vacancy.keySkills}));
  const result=await generateJson({userId,agent:'score-vacancies',model:provider==='api'?config.scoringFallbackModel:config.scoringModel,
    thinking:provider==='api'?config.scoringFallbackThinkingLevel:config.scoringThinkingLevel,schema:scoringResultSchema,
    system:`Score each CV-vacancy match independently. Use no fixed occupation taxonomy and never score keyword overlap without
role compatibility. Rubric: must-have skills 40, seniority/years 20, responsibilities 15, domain 10, location/work format 10,
compensation 5; missing salary is neutral. Penalize underqualification and substantial overqualification. An explicit hard
blocker sets hardRejection=true and caps score at 49. Return exactly one result for each vacancyId, at most three reasons and
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
      score.reasons.slice(0,3).map(reason=>reason.slice(0,240)),score.gaps.slice(0,3).map(gap=>gap.slice(0,240)),score.hardRejection);}
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
      throw new Error('ChatGPT subscription usage limit reached and OPENAI_API_KEY is not configured for scoring fallback.',
        { cause: error });
    }
    console.warn(`ChatGPT scoring limit reached; using metered OpenAI API fallback for ${vacancies.length} vacancies.`);
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
  let vacancies: Vacancy[];
  let calibrationContext: string | undefined;
  if (config.prefilterEnabled) {
    const cv = await getCvSource(userId);
    if (!cv) throw new Error('An authoritative CV source is required for pre-LLM filtering.');
    const cvText = cv.cvText;
    const cvContentHash = createHash('sha256').update(cvText).digest('hex');
    const careerProfile = parseStoredCareerProfile(
      await getSearchProfile<StoredCareerProfile>(userId, careerProfilePlatformId), cv.cvSha256,
    );
    if (!careerProfile) throw new Error('A current CV-derived career profile is required for prefiltering.');
    const careerProfileHash = createHash('sha256').update(JSON.stringify(careerProfile)).digest('hex');
    const contextHash = createHash('sha256').update([
      'prefilter-v5-cv-derived-lexical', cvContentHash, careerProfileHash, config.prefilterMinScore,
      config.prefilterAuditPercent,
    ].join(':')).digest('hex');
    calibrationContext = contextHash;
    const candidates = await vacanciesNeedingPrefilter(userId, contextHash, config.prefilterBatchSize);
    trace('prefilter.batch.start', { contextHash: contextHash.slice(0, 12), candidates: candidates.length,
      minimumScore: config.prefilterMinScore, auditPercent: config.prefilterAuditPercent });
    progress?.('filtering', 0, candidates.length);
    for (const [index, vacancy] of candidates.entries()) {
      const result = prefilterVacancy(cvText, vacancy, config.prefilterMinScore, careerProfile);
      const auditDigest = createHash('sha256').update(`${contextHash}:${vacancy.id}`).digest().readUInt32BE(0);
      const auditSelected = result.filtered && auditDigest / 0x1_0000_0000 * 100 < config.prefilterAuditPercent;
      await savePrefilterScore(userId, vacancy.id, contextHash, vacancy.contentHash, { ...result, auditSelected });
      trace('prefilter.vacancy.scored', { vacancyId: vacancy.id, source: vacancy.source, name: vacancy.name,
        auditSelected, ...result });
      progress?.('filtering', index + 1, candidates.length);
    }
    const stats = await prefilterQueueStats(userId, contextHash);
    const ranked = await rankedPendingVacancies(userId, contextHash, scoreLimit, Math.min(config.prefilterAuditSlots, scoreLimit));
    vacancies = ranked;
    trace('prefilter.queue.ranked', { ...stats, selected: ranked.map((vacancy) => ({
      vacancyId: vacancy.id, source: vacancy.source, name: vacancy.name, prefilterScore: vacancy.prefilterScore,
      auditSelected: vacancy.auditSelected,
    })) });
  } else {
    vacancies = await pendingVacancies(userId, scoreLimit);
  }
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
    } finally {
      progressed += batch.length;
      progress?.('scoring', progressed, vacancies.length);
    }
  })));
  trace('scoring.parallel.completed', { vacancies: vacancies.length, batches: batches.length });
  if (calibrationContext) {
    trace('prefilter.calibration', await prefilterCalibration(userId, calibrationContext, config.alertScore,
      config.prefilterCalibrationMinLabels));
  }
  return {attempted:vacancies.length,completed};
}

export async function tailorApplication(userId: string, vacancyId: number): Promise<GeneratedApplication> {
  await requireApprovedUser(userId);
  if (await usageInLast24Hours(userId, 'application') >= config.userDailyApplicationLimit) {
    throw new Error(`Daily application-generation limit (${config.userDailyApplicationLimit}) reached.`);
  }
  const vacancy = await getScoredVacancy(userId, vacancyId);
  if (!vacancy) throw new Error(`Scored vacancy ${vacancyId} was not found for this user.`);
  clearApplicationArtifacts(userId, vacancyId);
  await beginApplication(userId, vacancyId);
  try {
    const cv=await getCvSource(userId);if(!cv)throw new Error('The authoritative CV source was not found.');
    const documents=await generateJson({userId,agent:'tailor-application',model:config.model,thinking:config.thinkingLevel,
      schema:applicationResultSchema,system:`Create a tailored plain-text CV and cover letter from authoritative evidence only. Preserve all
employers, dates, titles, metrics, skills, degrees, languages and contacts without invention or inflation. Translate faithfully
into the vacancy language when needed. tailoredCvText starts with name, role and contacts, uses uppercase section headings and
one bullet per line beginning with •; no Markdown, HTML, Typst or code. The cover letter is concise and mentions concrete overlap.
Return exactly {"tailoredCvText":"...","coverLetter":"..."}. Use these exact field names.`,
      prompt:`CV DOCUMENT:\n${JSON.stringify(cv.document)}\n\nCV TEXT:\n${cv.cvText}\n\nVACANCY:\n${JSON.stringify(vacancy)}\n\nVACANCY LANGUAGE: ${detectCvLanguage(`${vacancy.name}\n${vacancy.description}`)}`});
    const application={tailoredCvPdf:compilePlainTextCv(documents.tailoredCvText),coverLetter:documents.coverLetter};
    stageApplicationArtifacts(userId,vacancyId,application);await markApplicationReady(userId,vacancyId);return application;
  } catch (error) {
    clearApplicationArtifacts(userId, vacancyId);
    try { await failApplication(userId, vacancyId, error instanceof Error ? error.message : String(error)); }
    catch (statusError) { console.error(`Could not persist failed application status: ${errorMessage(statusError)}`); }
    throw error;
  }
}
