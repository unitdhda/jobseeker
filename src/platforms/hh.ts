import * as v from 'valibot';
import { config } from '../config.ts';
import type { SearchPlatform } from './types.ts';

const id = v.pipe(v.string(), v.regex(/^\d+$/, 'Expected a numeric HH identifier'));
const shortText = v.pipe(v.string(), v.minLength(1), v.maxLength(240));
const ids = v.optional(v.pipe(v.array(id), v.maxLength(20)));
const searchFields = ['name', 'company_name', 'description'] as const;
const experiences = ['noExperience', 'between1And3', 'between3And6', 'moreThan6'] as const;
const employmentForms = ['FULL', 'PART', 'PROJECT', 'FLY_IN_FLY_OUT'] as const;
const workFormats = ['ON_SITE', 'REMOTE', 'HYBRID', 'FIELD_WORK'] as const;
const schedules = ['SIX_ON_ONE_OFF', 'FIVE_ON_TWO_OFF', 'FOUR_ON_FOUR_OFF', 'FOUR_ON_THREE_OFF', 'FOUR_ON_TWO_OFF', 'THREE_ON_THREE_OFF', 'THREE_ON_TWO_OFF', 'TWO_ON_TWO_OFF', 'TWO_ON_ONE_OFF', 'ONE_ON_THREE_OFF', 'ONE_ON_TWO_OFF', 'WEEKEND', 'FLEXIBLE', 'OTHER'] as const;
const hours = ['HOURS_2', 'HOURS_3', 'HOURS_4', 'HOURS_5', 'HOURS_6', 'HOURS_7', 'HOURS_8', 'HOURS_9', 'HOURS_10', 'HOURS_11', 'HOURS_12', 'HOURS_24', 'FLEXIBLE', 'OTHER'] as const;
const labels = ['with_address', 'accept_handicapped', 'not_from_agency', 'accept_kids', 'accredited_it', 'low_performance', 'internship', 'night_shifts', 'with_salary', 'accept_teens', 'accept_labor_contract'] as const;
const currencies = ['AZN', 'BYR', 'EUR', 'GEL', 'KGS', 'KZT', 'RUR', 'UAH', 'USD', 'UZS'] as const;

export const hhSearchProfileSchema = v.strictObject({
  version: v.literal(1),
  searches: v.pipe(v.array(v.strictObject({
    name: v.pipe(v.string(), v.minLength(2), v.maxLength(80)),
    rationale: v.pipe(v.string(), v.minLength(2), v.maxLength(300)),
    text: v.pipe(v.string(), v.minLength(2), v.maxLength(300),
      v.regex(/[А-Яа-яЁё]/, 'Search text must include a Russian role or function phrase')),
    excludedText: v.optional(shortText),
    searchFields: v.optional(v.pipe(v.array(v.picklist(searchFields)), v.minLength(1), v.maxLength(3))),
    areas: v.pipe(v.array(id), v.minLength(1), v.maxLength(10)),
    metro: ids,
    professionalRoles: ids,
    industries: ids,
    employerIds: ids,
    experience: v.optional(v.pipe(v.array(v.picklist(experiences)), v.maxLength(4))),
    employmentForms: v.optional(v.pipe(v.array(v.picklist(employmentForms)), v.maxLength(4))),
    workSchedules: v.optional(v.pipe(v.array(v.picklist(schedules)), v.maxLength(14))),
    workingHours: v.optional(v.pipe(v.array(v.picklist(hours)), v.maxLength(14))),
    workFormats: v.optional(v.pipe(v.array(v.picklist(workFormats)), v.maxLength(4))),
    education: v.optional(v.pipe(v.array(v.picklist(['not_required_or_not_specified', 'special_secondary', 'higher'])), v.maxLength(3))),
    driverLicenseTypes: v.optional(v.pipe(v.array(v.pipe(v.string(), v.regex(/^[A-Z0-9]+$/))), v.maxLength(10))),
    labels: v.optional(v.pipe(v.array(v.picklist(labels)), v.maxLength(11))),
    salary: v.optional(v.strictObject({
      amount: v.pipe(v.number(), v.integer(), v.minValue(1)),
      currency: v.picklist(currencies),
      frequency: v.optional(v.picklist(['DAILY', 'WEEKLY', 'TWICE_PER_MONTH', 'MONTHLY', 'PER_PROJECT'])),
      mode: v.optional(v.picklist(['MONTH', 'SHIFT', 'HOUR', 'FLY_IN_FLY_OUT', 'SERVICE'])),
    })),
    periodDays: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(30))),
    orderBy: v.optional(v.picklist(['publication_time', 'salary_desc', 'salary_asc', 'relevance'])),
  })), v.minLength(2), v.maxLength(8)),
});

export type HhSearchProfile = v.InferOutput<typeof hhSearchProfileSchema>;
export type HhSearch = HhSearchProfile['searches'][number];

export const hhPlatform: SearchPlatform<typeof hhSearchProfileSchema> = {
  id: 'hh',
  name: 'hh.ru browser search',
  schema: hhSearchProfileSchema,
  template: () => ({
    platform: 'hh',
    version: 1,
    purpose: 'Validated inputs for the hh.ru vacancy-search web page. Playwright opens these searches; this is not an API request.',
    jsonShape: {
      version: 1,
      searches: [{
        name: 'short unique label', rationale: 'why this search adds useful coverage', text: 'разработчик TypeScript React',
        excludedText: 'optional comma-separated exclusions', searchFields: ['name', 'description'],
        areas: [config.hhAreaId], metro: ['optional HH ids'], professionalRoles: ['optional HH ids'],
        industries: ['optional HH ids'], employerIds: ['optional HH ids'], experience: ['between3And6'],
        employmentForms: ['FULL'], workSchedules: ['FIVE_ON_TWO_OFF'], workingHours: ['HOURS_8'],
        workFormats: ['REMOTE', 'HYBRID'], education: ['higher'], driverLicenseTypes: ['B'],
        labels: ['accredited_it'], salary: { amount: 200000, currency: 'RUR', frequency: 'MONTHLY', mode: 'MONTH' },
        periodDays: 7, orderBy: 'publication_time',
      }],
    },
    capabilities: {
      configuredDefaultArea: config.hhAreaId,
      searchFields, experiences, employmentForms, workFormats, workSchedules: schedules,
      workingHours: hours, labels, currencies,
      education: ['not_required_or_not_specified', 'special_secondary', 'higher'],
      salaryFrequencies: ['DAILY', 'WEEKLY', 'TWICE_PER_MONTH', 'MONTHLY', 'PER_PROJECT'],
      salaryModes: ['MONTH', 'SHIFT', 'HOUR', 'FLY_IN_FLY_OUT', 'SERVICE'],
      orderBy: ['publication_time', 'salary_desc', 'salary_asc', 'relevance'],
      knownTechProfessionalRoles: {
        '96': 'Программист, разработчик', '104': 'Руководитель группы разработки', '124': 'Тестировщик',
        '160': 'DevOps-инженер', '156': 'BI-аналитик, аналитик данных', '165': 'Дата-сайентист',
        '148': 'Системный аналитик', '150': 'Бизнес-аналитик', '73': 'Менеджер продукта',
        '107': 'Руководитель проектов', '125': 'Технический директор (CTO)',
      },
    },
    rules: [
      'Every search text must contain Russian role or function terms; keep only standard technology and product names in English.',
      'Use only capabilities listed by this template; omit unsupported or unknown filters.',
      'Every search must include areas; use configuredDefaultArea unless the CV explicitly supports another location.',
      'Never infer salary, work format, education, licences, or availability merely from a job title.',
      'Prefer several complementary searches over one over-filtered search.',
      'Use professionalRoles only when the exact role ID is present in knownTechProfessionalRoles.',
      'Use strict filters only when they are explicit in the CV or operator input; recall matters.',
    ],
  }),
};

function appendMany(params: URLSearchParams, name: string, values?: readonly string[]): void {
  for (const value of values ?? []) params.append(name, value);
}

export function hhSearchUrl(search: HhSearch, page: number): string {
  const params = new URLSearchParams({ text: search.text, page: String(page), per_page: '100' });
  appendMany(params, 'search_field', search.searchFields);
  appendMany(params, 'area', search.areas);
  appendMany(params, 'metro', search.metro);
  appendMany(params, 'professional_role', search.professionalRoles);
  appendMany(params, 'industry', search.industries);
  appendMany(params, 'employer_id', search.employerIds);
  appendMany(params, 'experience', search.experience);
  appendMany(params, 'employment_form', search.employmentForms);
  appendMany(params, 'work_schedule_by_days', search.workSchedules);
  appendMany(params, 'working_hours', search.workingHours);
  appendMany(params, 'work_format', search.workFormats);
  appendMany(params, 'education', search.education);
  appendMany(params, 'driver_license_types', search.driverLicenseTypes);
  appendMany(params, 'label', search.labels);
  if (search.excludedText) params.set('excluded_text', search.excludedText);
  if (search.salary) {
    params.set('salary', String(search.salary.amount));
    params.set('currency', search.salary.currency);
    if (search.salary.frequency) params.set('salary_frequency', search.salary.frequency);
    if (search.salary.mode) params.set('salary_mode', search.salary.mode);
  }
  params.set('period', String(search.periodDays ?? 7));
  params.set('order_by', search.orderBy ?? 'publication_time');
  return `https://hh.ru/search/vacancy?${params}`;
}
