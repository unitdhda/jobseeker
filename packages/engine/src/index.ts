export type {
  CurrencyCode,
  CvContentHash,
  EmploymentType,
  ExperienceRequirement,
  PlannedSearch,
  SalaryPeriod,
  SalaryRange,
  SearchPlan,
  SearchRecipient,
  SourceKey,
  SourceVacancyId,
  UserId,
  VacancyCandidate,
  VacancyCandidateInput,
  VacancyContent,
  VacancyContentHash,
  VacancyInput,
  VacancyListingHash,
  VacancySourceIdentity,
  VacancyStatus,
  WorkFormat,
  WorkSchedule,
} from './contracts.ts';
export {
  parseCurrencyCode,
  parseCvContentHash,
  parseSourceKey,
  parseSourceVacancyId,
  parseUserId,
  parseVacancyContentHash,
  parseVacancyListingHash,
} from './contracts.ts';

export { canonicalRoleToken, roleNgramSimilarity, searchTokens } from './canon.ts';
export type { FilterSignature, SearchUnitId, UnitIdentity } from './identity.ts';
export { tokenSimilarity, unitIdentityOf } from './identity.ts';
export type {
  CompiledDemand,
  CompiledSubscription,
  CompiledUnit,
  DemandInput,
  NamedSearch,
} from './subscribe.ts';
export { compileDemand } from './subscribe.ts';
export type { CadencePolicy } from './cadence.ts';
export { nextCadence } from './cadence.ts';
export type { SchedulableUnit } from './pick.ts';
export { pickDueUnits } from './pick.ts';
export type { MatchState } from './match-state.ts';
export {
  assertTransition,
  canTransition,
  deliveredStates,
  MatchTransitionError,
} from './match-state.ts';
export type {
  CareerProfile,
  CareerTrack,
  PrefilterOptions,
  PrefilterResult,
  StoredCareerProfile,
  VacancyRecency,
  RecencyBand,
} from './prefilter.ts';
export {
  careerProfileLimits,
  careerProfileSchema,
  careerTrackSchema,
  combinedEvidenceScore,
  lexicalCosineSimilarity,
  normalizeCareerProfileJson,
  parseStoredCareerProfile,
  prefilterVacancy,
  vacancyRecency,
  vacancySemanticText,
} from './prefilter.ts';
export type { IdfEntry, IdfLookup, IdfLookups, IdfVocabulary } from './idf.ts';
export {
  buildIdfVocabulary,
  createIdfLookup,
  idfWeightedCosine,
  titleSpecificity,
  uniformIdfLookup,
  uniformIdfLookups,
} from './idf.ts';
export type {
  RoleEquivalencePair,
  RoleTokenResolver,
  RoleTrackTitles,
} from './equivalence.ts';
export {
  createRoleTokenResolver,
  identityRoleResolver,
  mineRoleEquivalences,
} from './equivalence.ts';
export type { OrderedProgressAggregator } from './concurrency.ts';
export {
  adaptiveConcurrency,
  AdaptiveTaskPool,
  aggregateOrderedProgress,
  KeyedTaskScheduler,
  mapConcurrent,
} from './concurrency.ts';
export type {
  MatchCandidateInput,
  MatchEvidence,
  MatchPorts,
  MatchReport,
  PlatformTickReport,
  TickDiscovery,
  TickPorts,
  TickReport,
  TickUnit,
} from './runtime.ts';
export { matchVacancy, nextWakeMs, runSchedulerTick } from './runtime.ts';
export type {
  DiscoveryPorts,
  DiscoveryReport,
  EngineLoop,
  EngineLoopStatus,
  JudgmentPorts,
  JudgmentReport,
  LaneClock,
  LaneStatus,
  LoopPorts,
  NormalizeReport,
  ScoreDueReport,
  ScoringPolicy,
  ScoringPorts,
} from './loop.ts';
export {
  createEngineLoop,
  drainScoring,
  runDiscoveryIteration,
  runJudgmentIteration,
} from './loop.ts';
