/**
 * The Russian catalogue, and the shape of every other one: `Messages` is derived from this object, so a message
 * added here does not compile until every locale carries it. Values are plain strings or functions of the values
 * they interpolate — never sentence fragments assembled by the caller, because word order is not shared between
 * languages. Anything already inside HTML markup keeps its tags here; the caller escapes only user data.
 */
import type { ApplicationArtifact, UserStatus } from '@jobseeker/store';

export const ru = {
  /** Intl tag for numbers, money and clock formatting under this locale. */
  tag: 'ru-RU',
  /** What this locale calls itself, for the language picker. */
  name: 'Русский',

  common: {
    yes: 'да',
    no: 'нет',
    ownerOnly: 'Эта команда доступна только владельцу.',
    ownerOnlyToast: 'Только для владельца',
    previousPage: '‹ Назад',
    nextPage: 'Далее ›',
    open: 'открыть',
    openAt: (source: string) => `Открыть ${source}`,
    unknownSource: 'источник',
  },

  /** Brand names stay as their owners write them; only the descriptive entries are translated. */
  userStatus: {
    unregistered: 'не зарегистрирован', pending: 'на рассмотрении', approved: 'одобрен',
    rejected: 'отклонён', revoked: 'отозван',
  } satisfies Record<UserStatus, string>,

  access: {
    denied: (status: string) => `Доступ: ${status}. Отправьте /request, чтобы запросить доступ у владельца бота.`,
    privateBot: (status: string) => 'Это приватный бот для поиска вакансий. Доступ подтверждает владелец.\n\n'
      + `Ваш статус: ${status}. Отправьте /request, чтобы подать заявку.`,
    alreadyGranted: 'У вас уже есть доступ. Отправьте /start, чтобы продолжить.',
    retryAfterMinutes: (minutes: number) => `Повторную заявку можно отправить через ${minutes} мин.`,
    alreadyPending: 'Заявка уже отправлена и ждёт решения владельца.',
    approveButton: 'Одобрить',
    rejectButton: 'Отклонить',
    requestCard: (nameHtml: string, userId: string) => `<b>Новая заявка на доступ</b>\n${nameHtml}\n`
      + `ID пользователя: <code>${userId}</code>`,
    requestSent: 'Заявка отправлена. Бот сообщит, когда владелец примет решение.',
    userNotFoundToast: 'Пользователь не найден',
    alreadyHandledToast: (status: string) => `Заявка уже обработана: ${status}`,
    approvedToast: 'Доступ одобрен',
    rejectedToast: 'Заявка отклонена',
    approvedNotice: 'Доступ одобрен. Отправьте /start, чтобы начать настройку.',
    rejectedNotice: 'Заявка отклонена. Позже вы сможете снова отправить /request.',
    revokedNotice: 'Ваш доступ к боту отозван. Позже можно снова отправить /request.',
  },

  start: {
    approved: (cvStatus: string, delivery: string) => 'Доступ открыт.\n\n'
      + '1. Загрузите актуальное резюме командой /cv.\n'
      + '2. Настройте время уведомлений и дайджеста командой /window.\n'
      + '3. Бот будет искать вакансии и оценивать их по вашему резюме.\n\n'
      + 'Поиск по найденным вакансиям: /search запрос\nЭкспорт данных: /export_me\nУдаление данных: /delete_me\n'
      + `Язык интерфейса: /language\nКак обрабатываются данные: /privacy\n\n${cvStatus}\nДоставка: ${delivery}`,
    ownerCommands: '\n\nКоманды владельца:\n/ok ID или @username — одобрить доступ\n'
      + '/users — пользователи и их активность\n/revoke ССЫЛКА — отозвать доступ\n'
      + '/usage — токены и стоимость модели\n/scraper — здоровье скрейпера и парсера\n/status — развёртывание и облако',
  },

  language: {
    prompt: (current: string) => `Язык интерфейса: ${current}. Выберите другой, если нужно.`,
    changed: (current: string) => `Язык интерфейса: ${current}.`,
    unchangedToast: 'Этот язык уже выбран',
  },

  owner: {
    users: {
      title: (page: number, pages: number) => `Пользователи — страница ${page}/${pages}`,
      reference: 'Ссылка',
      person: 'Пользователь',
      status: 'Статус',
      cv: 'CV',
      activity: 'Оценки\nОтклики',
      delivery: 'Доставка',
      legend: 'Оценки и отклики: за 24 часа / за всё время.',
      actions: 'Одобрить: /ok ID или @username. Отозвать: /revoke ССЫЛКА.',
    },
    approve: {
      usage: 'Укажите ID или username: /ok 123456789 или /ok @username',
      notFound: 'Пользователь не найден. Он должен сначала открыть бота или отправить /request.',
      alreadyApproved: 'У этого пользователя уже есть доступ.',
      done: (reference: string) => `Доступ одобрен: ${reference}.`,
      notifyFailed: 'Доступ сохранён, но уведомить пользователя не удалось.',
    },
    revoke: {
      usage: 'Сначала откройте /users, затем отправьте /revoke ССЫЛКА.',
      ambiguous: 'Ссылка не найдена или неоднозначна. Откройте /users и используйте ссылку из таблицы.',
      refusedOwner: 'Нельзя отозвать доступ у владельца.',
      done: (userId: string) => `Доступ пользователя ${userId} отозван.`,
    },
    usage: {
      title: '<b>Использование — 24 часа / всё время</b>',
      turns: (day: number, total: number) => `LLM-вызовы: <b>${day} / ${total}</b>`,
      tokens: (day: string, total: string) => `Токены: <b>${day} / ${total}</b>`,
      cost: (day: string, total: string) => `Стоимость модели: <b>${day} / ${total}</b>`,
    },
    hourlyTitle: '<b>Почасовая динамика за 24 часа</b>',
    deploymentTitle: '<b>Развёртывание и облако</b>',
  },

  charts: {
    scale: '2 символа на час · точка каждый час · ━ и ◐ — серии совпадают',
    yesterday: 'вчера',
    today: 'сегодня',
    localTime: 'местное время →',
    usageLegend: '● Токены — левая ось             ○ Деньги — правая ось',
    scraperLegend: '● Оценки — левая ось          ○ Распознано — правая ось',
  },

  scraper: {
    title: '<b>Скрейпер и парсер — 24 часа</b>',
    listings: (discovered: number, normalized: number, queued: number) =>
      `Листинги: <b>${discovered}</b> новых · распознано: <b>${normalized}</b> · очередь: ${queued}`,
    matches: (matched: number, scored: number) => `Матчи: <b>${matched}</b> · оценки: <b>${scored}</b>`,
    bySource: '<b>По источникам</b>',
    sourceRow: (source: string, discovered: number, normalized: number, queued: number, failed: number,
      closed: number, scored: number) => `• ${source}: ${discovered} новых · ${normalized} распознано · `
      + `очередь ${queued} · сбоев ${failed} · закрыто ${closed} · оценок ${scored}`,
    units: '<b>Поисковые юниты</b>',
    unitRow: (platform: string, units: number, overdue: number, cadenceMin: number, cadenceMax: number,
      novelty: string) => `• ${platform}: ${units} юнитов · просрочено ${overdue} · `
      + `каденция ${cadenceMin}–${cadenceMax} мин · ${novelty}`,
    noveltyHoursAgo: (hours: number) => `новизна ${hours} ч назад`,
    noNovelty: 'новизны не было',
    errors: '<b>Ошибки парсера за 24 часа</b>',
    errorRow: (error: string, count: number) => `• ${error} ×${count}`,
  },

  deployment: {
    memory: (rss: number, heap: number) => `Память RSS: ${rss} MiB · heap: ${heap} MiB`,
    cpu: (seconds: string, hours: string) => `CPU процесса: ${seconds} c · uptime: ${hours} ч`,
    worker: (active: number, pending: number, capacity: number) =>
      `Локальный job worker: ${active}/1 · очередь: ${pending}/${capacity}`,
    aiWorkers: (minimum: number, maximum: number) => `AI workers: ${minimum}–${maximum}`,
    telegram: (mode: string) => `Telegram: ${mode}`,
    cycle: (state: string) => `Цикл: ${state}`,
    lanes: (discovery: string, judgment: string) => `две полосы · ${discovery} · ${judgment}`,
    discoveryLane: 'разведка:',
    judgmentLane: 'оценка:',
    laneIterations: (label: string, iterations: number) => `${label} ${iterations}`,
    laneLastRun: (clock: string) => ` (последняя ${clock})`,
    laneFailures: (failures: string) => ` · сбои: ${failures}`,
    schedulerElsewhere: 'планировщик вне этого процесса',
    calibrationOk: (days: string) => `Порядок: калиброван · обучен ${days} дн. назад`,
    calibrationStale: (days: string) => `Порядок: калиброван, но УСТАРЕЛ · обучен ${days} дн. назад, замены не было`,
    calibrationMissing: 'Порядок: НЕ калиброван · откат на сырой балл',
  },

  cv: {
    present: 'Резюме загружено',
    absent: 'Резюме не загружено',
    noArguments: 'Просто отправьте команду /cv без дополнительных параметров.',
    cooldownMinutes: (minutes: number) => `Новую загрузку можно начать через ${minutes} мин.`,
    prompt: (status: string) => `${status}.\n\nПришлите актуальное резюме одним файлом: PDF, Markdown, TXT или DOCX `
      + 'до 20 МБ. Новое резюме заменит предыдущее. Загружая файл, вы соглашаетесь с условиями /privacy.',
    uploadFirst: 'Сначала отправьте /cv, затем прикрепите файл с резюме.',
    tooLarge: 'Файл больше 20 МБ. Пришлите файл меньшего размера.',
    unsupportedFormat: 'Поддерживаются только PDF, Markdown, TXT и DOCX.',
    downloading: 'Загружаю файл',
    parsing: 'Разбираю резюме',
    saved: 'Резюме сохранено · готовлю поисковые запросы',
    importFailed: 'Не удалось обработать файл. Проверьте формат и размер, затем попробуйте снова.',
    retryUpload: 'Пришлите резюме одним файлом ещё раз: PDF, Markdown, TXT или DOCX до 20 МБ.',
    retryUploadButton: 'Загрузить резюме заново',
    retryRefreshButton: 'Повторить подготовку',
    preparingSearchesToast: 'Готовлю поисковые запросы…',
    preparingSearches: 'Готовлю поисковые запросы',
    unreadable: 'Не удалось прочитать сохранённое резюме. Попробуйте ещё раз.',
    missing: 'Резюме не найдено. Загрузите файл заново командой /cv.',
    refreshInFlight: 'Поисковые настройки уже готовятся. Дождитесь итогового сообщения.',
    refreshFailed: 'Резюме сохранено, но поисковые настройки пока не удалось обновить. Бот повторит попытку '
      + 'в следующем цикле, когда позволит лимит.',
  },

  profile: {
    title: '<b>Поисковый профиль</b>',
    filename: (name: string) => `Резюме: ${name}`,
    tracks: (shown: string) => `Направления: ${shown}`,
    andMore: (count: number) => ` и ещё ${count}`,
    none: 'Поисковые запросы пока не созданы.',
    queries: (searches: number, platforms: number) => `<b>Запросы: ${searches} на ${platforms} площадках</b>`,
    platformRow: (platform: string, terms: string) => `• ${platform}: ${terms}`,
    term: (term: string) => `«${term}»`,
    withoutQueries: (platforms: string) => `Без запросов: ${platforms}.`,
    footer: 'Запросы будут использованы в следующем цикле поиска. Заменить резюме: /cv.',
    cvMissing: 'Резюме не загружено. Отправьте /cv, чтобы загрузить файл.',
  },

  delivery: {
    settings: (status: string) => `Настройки доставки: ${status}`,
    windowButton: '🕒 Время уведомлений',
    timezoneButton: '🌍 Часовой пояс',
    digestButton: '📬 Время дайджеста',
    removeButton: '🗑 Удалить окно',
    askStart: 'Во сколько начинать уведомления? Отправьте время ЧЧ:ММ, например 09:00.',
    askEnd: 'Во сколько заканчивать уведомления? Отправьте время ЧЧ:ММ, например 22:00.',
    askDigest: 'Во сколько присылать ежедневную подборку? Отправьте время ЧЧ:ММ, например 09:30.',
    askTimezone: 'Укажите смещение от UTC: например +3, -5 или +3:30.',
    windowSaved: (status: string) => `Время уведомлений сохранено. ${status}`,
    digestSaved: (status: string) => `Время дайджеста сохранено. ${status}`,
    timezoneSaved: (status: string) => `Часовой пояс сохранён. ${status}`,
    windowRemoved: (status: string) => `Окно уведомлений удалено. ${status}`,
    status: (alerts: string, digest: string, timezone: string, isDefault: boolean) =>
      `уведомления: ${alerts}; дайджест: ${digest}; ${timezone}${isDefault ? ' (по умолчанию)' : ''}`,
    anyTime: 'в любое время',
    invalidClock: 'Введите время в формате ЧЧ:ММ, например 09:30.',
    clockOutOfRange: 'Время должно быть в диапазоне от 00:00 до 23:59.',
    invalidOffset: 'Укажите смещение от UTC, например +3, -5 или +3:30.',
    offsetOutOfRange: 'Смещение UTC должно быть от -14:00 до +14:00.',
    equalBounds: 'Время начала и окончания уведомлений должно отличаться.',
  },

  digest: {
    title: (pages: string) => `<b>Ежедневная подборка вакансий${pages}</b>`,
    pageSuffix: (page: number, pages: number) => ` · стр. ${page}/${pages}`,
    footer: 'Пришлите выделенный префикс или полный ID, чтобы получить адаптированное резюме и сопроводительное письмо.',
    empty: 'Нет новых вакансий для дайджеста.',
  },

  alert: {
    header: (score: number, name: string) => `<b>${score}/100 — ${name}</b>`,
    applyId: (applyId: string) => `ID: <code>${applyId}</code>`,
    origin: (employer: string, area: string, source: string) => `${employer} · ${area} · ${source}`,
    trackAndSalary: (track: string, salary: string) => `Направление: ${track} · Зарплата: ${salary}`,
    summary: (summary: string) => `\n<b>Комментарий к оценке</b>\n${summary}`,
    reasons: (reasons: string) => `\n<b>Почему подходит</b>\n${reasons}`,
    gaps: (gaps: string) => `\n<b>На что обратить внимание</b>\n${gaps}`,
    salaryUnspecified: 'не указана',
    salaryFrom: (from: string) => `от ${from}`,
    salaryTo: (to: string) => `до ${to}`,
    salaryNet: ' на руки',
  },

  search: {
    usage: 'Добавьте запрос после команды: /search должность, компания или навык',
    empty: 'В оценённых вакансиях ничего не найдено. Попробуйте другие слова.',
    result: (score: number, name: string, employer: string, applyId: string, url: string, open: string) =>
      `<b>${score}/100 — ${name}</b>\n${employer} · <code>${applyId}</code> · <a href="${url}">${open}</a>`,
    noVacancy: (reference: string) => `Нет оценённой вакансии с ID ${reference}.`,
    ambiguous: (reference: string) => `Префикс ${reference} подходит к нескольким вакансиям. Пришлите больше букв.`,
    vacancyCard: (name: string, employer: string, applyId: string) =>
      `<b>${name}</b>\n${employer} · <code>${applyId}</code>`,
  },

  application: {
    artifacts: {
      cv: { button: '📄 Резюме', loader: 'Адаптирую резюме', sending: 'Отправляю резюме', noun: 'резюме' },
      letter: { button: '✉️ Письмо', loader: 'Пишу письмо', sending: 'Отправляю письмо', noun: 'сопроводительное письмо' },
    } satisfies Record<ApplicationArtifact, { button: string; loader: string; sending: string; noun: string }>,
    skipButton: 'Пропустить',
    skippedToast: 'Вакансия пропущена',
    retryButton: 'Попробовать снова',
    busyToast: 'Сначала дождитесь текущей задачи',
    cvCaption: (name: string) => `Адаптированное резюме — ${name}`,
    cvLimit: (limit: number) => `Дневной лимит адаптированных резюме (${limit}) исчерпан. `
      + 'Письмо всё ещё можно подготовить.',
    letterLimit: (limit: number) => `Дневной лимит сопроводительных писем (${limit}) исчерпан.`,
    withId: (message: string, applyId: string) => `${message} ID: ${applyId}.`,
    gone: (applyId: string) => `Вакансия ${applyId} больше недоступна для подготовки документов.`,
    storeUnavailable: (applyId: string) => `Временная ошибка базы данных для вакансии ${applyId}. Пришлите ID ещё раз.`,
    failed: (noun: string, applyId: string) =>
      `Не удалось подготовить ${noun} для вакансии ${applyId}. Пришлите ID ещё раз или нажмите кнопку.`,
  },

  workflow: {
    kinds: {
      'cv-import': 'загрузка и разбор резюме',
      'profile-refresh': 'подготовка поисковых настроек по резюме',
      'tailored-cv': 'подготовка адаптированного резюме',
      'cover-letter': 'подготовка сопроводительного письма',
    },
    unknownKind: 'другая операция с резюме или документами',
    busy: (active: string, requested: string) =>
      `Сейчас уже выполняется: «${active}». Запрос «${requested}» не запущен.\n\n`
      + 'Одновременно для одного пользователя выполняется только одна такая задача. Повторные нажатия не ставятся '
      + 'в очередь и не запускают дополнительные обращения к языковой модели. Дождитесь итогового сообщения об '
      + 'успехе или ошибке, затем повторите запрос.',
  },

  personalData: {
    confirmPrompt: 'Это навсегда удалит ваше резюме, поисковые настройки, оценки, решения, сохранённые отклики, '
      + 'статистику, настройки доставки и выбранный язык интерфейса. Общая база вакансий останется. '
      + 'Для подтверждения отправьте /delete_me confirm.',
    busy: 'Сейчас выполняется задача с вашим резюме или откликом. Дождитесь её итогового сообщения и повторите удаление.',
    deleted: 'Ваши персональные данные удалены, включая язык интерфейса: дальше бот снова будет ориентироваться '
      + 'на язык вашего Telegram, пока вы не выберете его командой /language. Доступ к боту сохранён — '
      + 'загрузить новое резюме можно командой /cv.',
    privacy: 'Как обрабатываются данные:\n\n'
      + '• В приватной базе хранятся текст и структура резюме, поисковые настройки, числовые оценки, статистика, '
      + 'состояние доставки и выбранный язык интерфейса.\n'
      + '• Текст резюме и вакансий передаётся настроенной языковой модели для поиска, оценки и подготовки отклика.\n'
      + '• Чтобы одинаковые поиски выполнялись один раз, формулировки поисковых запросов — но не имя, контакты '
      + 'или текст резюме — общие для пользователей этой инсталляции; формулировка может быть предложена без '
      + 'указания автора при формировании поискового профиля другого пользователя.\n'
      + '• Исходный загруженный файл и завершённые диалоги с моделью не сохраняются. Для повторной отправки готового '
      + 'отклика сохраняются текст сопроводительного письма и Telegram file_id адаптированного PDF; сам PDF в базе '
      + 'не хранится.\n'
      + '• Пояснение к высокой оценке хранится только до отправки уведомления.\n'
      + '• Экспорт, включая сохранённые отклики: /export_me. Полное удаление: /delete_me confirm.\n\n'
      + 'Загружая резюме через /cv, вы соглашаетесь с этой обработкой.',
  },

  commands: {
    start: 'Начало работы и статус',
    request: 'Запросить доступ',
    cv: 'Загрузить или заменить резюме',
    privacy: 'Как обрабатываются данные',
    window: 'Настроить время уведомлений',
    digest: 'Состояние ежедневного дайджеста',
    search: 'Поиск по оценённым вакансиям',
    language: 'Язык интерфейса',
    export_me: 'Экспортировать свои данные',
    delete_me: 'Удалить свои данные',
  },
};

/** Every locale carries exactly the Russian catalogue's messages, with the same interpolated values. */
export type Messages = typeof ru;
