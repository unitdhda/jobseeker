export const ru = {
  languageName: 'Русский',
  startUnknown: '👋 <b>Добро пожаловать в Jobseeker</b>\n\nЯ нахожу вакансии под ваш опыт, оцениваю их по резюме и присылаю сюда самые сильные совпадения.\n\nЭто приватный сервис. Отправьте /request, чтобы запросить доступ у владельца. Язык всегда можно сменить командой /language.',
  startPending: '👋 <b>Запрос передан владельцу</b>\n\nПосле одобрения вы сможете загрузить резюме и получать подходящие вакансии. Сейчас больше ничего делать не нужно.',
  startApproved: '👋 <b>Добро пожаловать в Jobseeker</b>\n\nЯ постоянно ищу вакансии под ваше резюме, объясняю соответствие и помогаю подготовить адаптированное CV или сопроводительное письмо.\n\n<b>Как начать</b>\n1. Отправьте /cv и загрузите файл с резюме.\n2. Проверьте и подтвердите извлечённый профиль.\n3. Я начну поиск и буду присылать сюда сильные совпадения.\n\n/digest покажет текущие совпадения, /search найдёт вакансию в истории, /window настроит ежедневную доставку, а /privacy откроет управление данными.',
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
  matchCodeNotFound: 'Вакансия с таким кодом не найдена.',
  matchCodeAmbiguous: 'Этот префикс подходит к нескольким вакансиям. Отправьте больше букв кода.',
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
