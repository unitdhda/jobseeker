export const ru = {
  languageName: 'Русский',
  startUnknown: 'Это приватный бот поиска вакансий. Отправьте /request, чтобы запросить доступ.',
  startPending: 'Запрос доступа ожидает решения владельца.',
  startApproved: 'Доступ разрешён. Загрузите или обновите резюме командой /cv.',
  accessRequested: 'Запрос доступа отправлен владельцу.',
  accessCooldown: (seconds: number) => `Повторный запрос можно отправить через ${seconds} сек.`,
  accessDenied: 'Для этой команды нужен одобренный доступ.',
  privateOnly: 'Бот работает только в личных чатах.',
  languagePrompt: 'Выберите язык интерфейса.',
  languageChanged: 'Язык интерфейса изменён.',
  busy: (operation: string) => `Уже выполняется операция: ${operation}. Дождитесь её завершения.`,
  workflowLost: 'Срок блокировки операции истёк. Повторите действие.',
  cvSendDocument: 'Отправьте PDF, DOCX, Markdown или текстовый файл с резюме.',
  cvProcessing: 'Извлекаю и проверяю резюме…',
  cvReady: 'Резюме сохранено. Обновляю профиль поиска…',
  cvRejected: 'Предпросмотр отклонён. Можно отправить другой файл.',
  applicationPreparingCv: 'Готовлю адаптированное резюме…',
  applicationPreparingLetter: 'Готовлю сопроводительное письмо…',
  applicationFailed: 'Не удалось подготовить материал. Попробуйте позже.',
  noDigest: 'Подходящих вакансий для дайджеста пока нет.',
  digestTitle: (page: number, pages: number) => `Дайджест вакансий · ${page}/${pages}`,
  scoreLabel: 'Оценка',
  salaryUnknown: 'зарплата не указана',
  sourceLabel: 'Источник',
  reasonsLabel: 'Почему подходит',
  gapsLabel: 'Пробелы',
  buttonCv: 'CV',
  buttonLetter: 'Письмо',
  buttonSkip: 'Пропустить',
  buttonSource: 'Открыть',
  buttonPrevious: '←',
  buttonNext: '→',
  statusRunning: 'работает',
  statusIdle: 'ожидает',
  statusOff: 'выключен',
  unknownError: 'Неизвестная ошибка.',
} as const;

/** Russian owns catalogue keys and function parameter tuples; translations may change text but not API shape. */
export type Catalogue = {
  readonly [Key in keyof typeof ru]: typeof ru[Key] extends (...args: infer Args) => string
    ? (...args: Args) => string
    : string;
};

export default ru;
