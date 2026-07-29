import type { BaseIssue, BaseSchema } from 'valibot';
import { hhPlatform } from './hh.ts';
import { hireHiPlatform } from './hirehi.ts';
import {
  avitoPlatform, geekjobPlatform, getmatchPlatform, habrPlatform, rabotaPlatform, superjobPlatform,
} from './additional.ts';
import type { SearchPlatform } from './types.ts';

type AnyPlatform = SearchPlatform<BaseSchema<unknown, unknown, BaseIssue<unknown>>>;
const registeredPlatforms = [
  hhPlatform, hireHiPlatform, habrPlatform, getmatchPlatform, geekjobPlatform,
  superjobPlatform, avitoPlatform, rabotaPlatform,
] as const;
const platforms = new Map<string, AnyPlatform>(registeredPlatforms.map((platform) =>
  [platform.id, platform as AnyPlatform]));

export const searchPlatformIds = registeredPlatforms.map((platform) => platform.id);

export function getSearchPlatform(id: string): AnyPlatform {
  const platform = platforms.get(id);
  if (!platform) throw new Error(`Unknown search platform: ${id}`);
  return platform;
}
