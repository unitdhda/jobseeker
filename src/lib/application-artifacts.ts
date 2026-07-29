export interface GeneratedApplication {
  tailoredCvPdf: Buffer;
  coverLetter: string;
}

const staged = new Map<string, GeneratedApplication>();
const key = (userId: string, vacancyId: number): string => `${userId}:${vacancyId}`;

export function stageApplicationArtifacts(userId: string, vacancyId: number, artifacts: GeneratedApplication): void {
  staged.set(key(userId, vacancyId), artifacts);
}

export function getApplicationArtifacts(userId: string, vacancyId: number): GeneratedApplication | null {
  return staged.get(key(userId, vacancyId)) ?? null;
}

export function clearApplicationArtifacts(userId: string, vacancyId: number): void {
  staged.delete(key(userId, vacancyId));
}
