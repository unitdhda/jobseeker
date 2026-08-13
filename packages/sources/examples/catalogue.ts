export const exampleSourceIds = Object.freeze([
  'habr',
  'rabota',
  'hirehi',
  'geekjob',
  'avito',
  'trudvsem',
  'ats',
  'yandex',
  'ozon',
  'rwb',
  'mts',
  'vk',
  'kontur',
  'magnit',
  'yadro',
  'selectel',
  'sber',
  'kaspersky',
  'tbank',
] as const);

export type ExampleSourceId = typeof exampleSourceIds[number];

export default function register(): void {}
