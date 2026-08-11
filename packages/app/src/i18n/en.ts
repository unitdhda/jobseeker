/**
 * The English catalogue. Typed against the Russian one, so a missing or wrongly parameterized message is a
 * compile error rather than a Russian sentence appearing in an English conversation.
 */
import type { Messages } from './ru.ts';

export const en: Messages = {
  tag: 'en-GB',
  name: 'English',

  common: {
    yes: 'yes',
    no: 'no',
    ownerOnly: 'This command is available to the bot owner only.',
    ownerOnlyToast: 'Owner only',
    previousPage: '‹ Back',
    nextPage: 'Next ›',
    open: 'open',
    openAt: (source: string) => `Open on ${source}`,
    unknownSource: 'source',
  },

  userStatus: {
    unregistered: 'not registered', pending: 'awaiting a decision', approved: 'approved',
    rejected: 'rejected', revoked: 'revoked',
  },

  access: {
    denied: (status: string) => `Access: ${status}. Send /request to ask the bot owner for access.`,
    privateBot: (status: string) => 'This is a private job-search bot. The owner grants access.\n\n'
      + `Your status: ${status}. Send /request to apply.`,
    alreadyGranted: 'You already have access. Send /start to continue.',
    retryAfterMinutes: (minutes: number) => `You can apply again in ${minutes} min.`,
    alreadyPending: 'Your request has been sent and is waiting for the owner.',
    approveButton: 'Approve',
    rejectButton: 'Reject',
    requestCard: (nameHtml: string, userId: string) => `<b>New access request</b>\n${nameHtml}\n`
      + `User ID: <code>${userId}</code>`,
    requestSent: 'Request sent. The bot will tell you once the owner decides.',
    userNotFoundToast: 'User not found',
    alreadyHandledToast: (status: string) => `Already handled: ${status}`,
    approvedToast: 'Access granted',
    rejectedToast: 'Request rejected',
    approvedNotice: 'Access granted. Send /start to begin setting things up.',
    rejectedNotice: 'Request rejected. You can send /request again later.',
    revokedNotice: 'Your access to the bot has been revoked. You can send /request again later.',
  },

  start: {
    approved: (cvStatus: string, delivery: string) => 'Access granted.\n\n'
      + '1. Upload your current CV with /cv.\n'
      + '2. Set your alert and digest times with /window.\n'
      + '3. The bot will find vacancies and score them against your CV.\n\n'
      + 'Search what has been found: /search query\nExport your data: /export_me\nDelete your data: /delete_me\n'
      + `Interface language: /language\nHow your data is handled: /privacy\n\n${cvStatus}\nDelivery: ${delivery}`,
    ownerCommands: '\n\nOwner commands:\n/ok ID or @username — grant access\n'
      + '/users — users and their activity\n/revoke REF — revoke access\n'
      + '/usage — model tokens and cost\n/scraper — scraper and parser health\n/status — deployment and cloud',
  },

  language: {
    prompt: (current: string) => `Interface language: ${current}. Pick another one if you need to.`,
    changed: (current: string) => `Interface language: ${current}.`,
    unchangedToast: 'Already using this language',
  },

  owner: {
    users: {
      title: (page: number, pages: number) => `Users — page ${page}/${pages}`,
      reference: 'Ref',
      person: 'User',
      status: 'Status',
      cv: 'CV',
      activity: 'Scores\nApplications',
      delivery: 'Delivery',
      legend: 'Scores and applications: last 24 hours / all time.',
      actions: 'Approve: /ok ID or @username. Revoke: /revoke REF.',
    },
    approve: {
      usage: 'Give an ID or a username: /ok 123456789 or /ok @username',
      notFound: 'User not found. They have to open the bot or send /request first.',
      alreadyApproved: 'That user already has access.',
      done: (reference: string) => `Access granted: ${reference}.`,
      notifyFailed: 'Access was saved, but the user could not be notified.',
    },
    revoke: {
      usage: 'Open /users first, then send /revoke REF.',
      ambiguous: 'That reference is unknown or ambiguous. Open /users and take the reference from the table.',
      refusedOwner: 'The owner’s own access cannot be revoked.',
      done: (userId: string) => `Access revoked for user ${userId}.`,
    },
    usage: {
      title: '<b>Usage — 24 hours / all time</b>',
      turns: (day: number, total: number) => `LLM calls: <b>${day} / ${total}</b>`,
      tokens: (day: string, total: string) => `Tokens: <b>${day} / ${total}</b>`,
      cost: (day: string, total: string) => `Model cost: <b>${day} / ${total}</b>`,
    },
    hourlyTitle: '<b>Hour by hour over 24 hours</b>',
    deploymentTitle: '<b>Deployment and cloud</b>',
  },

  charts: {
    scale: '2 characters per hour · a point every hour · ━ and ◐ mean the series coincide',
    yesterday: 'yesterday',
    today: 'today',
    localTime: 'local time →',
    usageLegend: '● Tokens — left axis             ○ Money — right axis',
    scraperLegend: '● Scored — left axis          ○ Parsed — right axis',
  },

  scraper: {
    title: '<b>Scraper and parser — 24 hours</b>',
    listings: (discovered: number, normalized: number, queued: number) =>
      `Listings: <b>${discovered}</b> new · parsed: <b>${normalized}</b> · queued: ${queued}`,
    matches: (matched: number, scored: number) => `Matches: <b>${matched}</b> · scored: <b>${scored}</b>`,
    bySource: '<b>By source</b>',
    sourceRow: (source: string, discovered: number, normalized: number, queued: number, failed: number,
      closed: number, scored: number) => `• ${source}: ${discovered} new · ${normalized} parsed · `
      + `queued ${queued} · failed ${failed} · closed ${closed} · scored ${scored}`,
    units: '<b>Search units</b>',
    unitRow: (platform: string, units: number, overdue: number, cadenceMin: number, cadenceMax: number,
      novelty: string) => `• ${platform}: ${units} units · overdue ${overdue} · `
      + `cadence ${cadenceMin}–${cadenceMax} min · ${novelty}`,
    noveltyHoursAgo: (hours: number) => `novelty ${hours} h ago`,
    noNovelty: 'no novelty yet',
    errors: '<b>Parser errors over 24 hours</b>',
    errorRow: (error: string, count: number) => `• ${error} ×${count}`,
  },

  deployment: {
    memory: (rss: number, heap: number) => `Memory RSS: ${rss} MiB · heap: ${heap} MiB`,
    cpu: (seconds: string, hours: string) => `Process CPU: ${seconds} s · uptime: ${hours} h`,
    worker: (active: number, pending: number, capacity: number) =>
      `Local job worker: ${active}/1 · queued: ${pending}/${capacity}`,
    aiWorkers: (minimum: number, maximum: number) => `AI workers: ${minimum}–${maximum}`,
    telegram: (mode: string) => `Telegram: ${mode}`,
    cycle: (state: string) => `Cycle: ${state}`,
    lanes: (discovery: string, judgment: string) => `two lanes · ${discovery} · ${judgment}`,
    discoveryLane: 'discovery:',
    judgmentLane: 'judgment:',
    laneIterations: (label: string, iterations: number) => `${label} ${iterations}`,
    laneLastRun: (clock: string) => ` (last ${clock})`,
    laneFailures: (failures: string) => ` · failures: ${failures}`,
    schedulerElsewhere: 'scheduler runs outside this process',
  },

  cv: {
    present: 'CV uploaded',
    absent: 'No CV uploaded',
    noArguments: 'Just send /cv on its own, without any arguments.',
    cooldownMinutes: (minutes: number) => `You can start a new upload in ${minutes} min.`,
    prompt: (status: string) => `${status}.\n\nSend your current CV as a single file: PDF, Markdown, TXT or DOCX `
      + 'up to 20 MB. A new CV replaces the previous one. By uploading it you accept the terms in /privacy.',
    uploadFirst: 'Send /cv first, then attach your CV file.',
    tooLarge: 'That file is over 20 MB. Send a smaller one.',
    unsupportedFormat: 'Only PDF, Markdown, TXT and DOCX are supported.',
    downloading: 'Downloading the file',
    parsing: 'Reading the CV',
    saved: 'CV saved · preparing search queries',
    previewTitle: '<b>Check the extracted CV</b>',
    previewStats: (filename:string,characters:number,blocks:number) =>
      `File: ${filename} · ${characters.toLocaleString('en')} characters · ${blocks} blocks`,
    previewClean: 'No extraction warnings.',
    previewWarnings: (warnings:string) => `Check these extraction warnings: ${warnings}.`,
    previewQuestion: 'Does this look like your CV? It will not replace the current CV until you confirm.',
    confirmButton: 'Use this CV',
    rejectButton: 'Upload another',
    confirmedToast: 'CV confirmed',
    previewExpiredToast: 'Preview expired; upload again',
    ocrRequired: 'This PDF has no readable text layer. Export or scan it with OCR, then upload the searchable PDF.',
    importFailed: 'The file could not be processed. Check its format and size, then try again.',
    retryUpload: 'Send the CV again as a single file: PDF, Markdown, TXT or DOCX up to 20 MB.',
    retryUploadButton: 'Upload the CV again',
    retryRefreshButton: 'Prepare again',
    preparingSearchesToast: 'Preparing search queries…',
    preparingSearches: 'Preparing search queries',
    unreadable: 'The stored CV could not be read. Please try again.',
    missing: 'No CV found. Upload the file again with /cv.',
    refreshInFlight: 'Search settings are already being prepared. Wait for the final message.',
    refreshFailed: 'The CV was saved, but the search settings could not be updated yet. The bot will retry on the '
      + 'next cycle, once the limit allows.',
  },

  profile: {
    title: '<b>Search profile</b>',
    filename: (name: string) => `CV: ${name}`,
    tracks: (shown: string) => `Tracks: ${shown}`,
    andMore: (count: number) => ` and ${count} more`,
    none: 'No search queries have been created yet.',
    queries: (searches: number, platforms: number) => `<b>Queries: ${searches} across ${platforms} platforms</b>`,
    platformRow: (platform: string, terms: string) => `• ${platform}: ${terms}`,
    term: (term: string) => `“${term}”`,
    withoutQueries: (platforms: string) => `Without queries: ${platforms}.`,
    footer: 'These queries will be used on the next search cycle. Replace the CV: /cv.',
    cvMissing: 'No CV uploaded. Send /cv to upload one.',
  },

  delivery: {
    settings: (status: string) => `Delivery settings: ${status}`,
    windowButton: '🕒 Alert hours',
    timezoneButton: '🌍 Time zone',
    digestButton: '📬 Digest time',
    removeButton: '🗑 Remove the window',
    askStart: 'When should alerts start? Send the time as HH:MM, for example 09:00.',
    askEnd: 'When should alerts stop? Send the time as HH:MM, for example 22:00.',
    askDigest: 'When should the daily digest arrive? Send the time as HH:MM, for example 09:30.',
    askTimezone: 'Give your offset from UTC: for example +3, -5 or +3:30.',
    windowSaved: (status: string) => `Alert hours saved. ${status}`,
    digestSaved: (status: string) => `Digest time saved. ${status}`,
    timezoneSaved: (status: string) => `Time zone saved. ${status}`,
    windowRemoved: (status: string) => `Alert window removed. ${status}`,
    status: (alerts: string, digest: string, timezone: string, isDefault: boolean) =>
      `alerts: ${alerts}; digest: ${digest}; ${timezone}${isDefault ? ' (default)' : ''}`,
    anyTime: 'any time',
    invalidClock: 'Send the time as HH:MM, for example 09:30.',
    clockOutOfRange: 'The time must be between 00:00 and 23:59.',
    invalidOffset: 'Give an offset from UTC, for example +3, -5 or +3:30.',
    offsetOutOfRange: 'The UTC offset must be between -14:00 and +14:00.',
    equalBounds: 'The start and end of the alert window must differ.',
  },

  digest: {
    title: (pages: string) => `<b>Daily vacancy digest${pages}</b>`,
    pageSuffix: (page: number, pages: number) => ` · p. ${page}/${pages}`,
    footer: 'Send the highlighted prefix or the full ID to get a tailored CV and a cover letter.',
    empty: 'No new vacancies for the digest.',
  },

  alert: {
    header: (score: number, name: string) => `<b>${score}/100 — ${name}</b>`,
    applyId: (applyId: string) => `ID: <code>${applyId}</code>`,
    origin: (employer: string, area: string, source: string) => `${employer} · ${area} · ${source}`,
    trackAndSalary: (track: string, salary: string) => `Track: ${track} · Salary: ${salary}`,
    summary: (summary: string) => `\n<b>Why this score</b>\n${summary}`,
    reasons: (reasons: string) => `\n<b>What fits</b>\n${reasons}`,
    gaps: (gaps: string) => `\n<b>What to watch out for</b>\n${gaps}`,
    salaryUnspecified: 'not stated',
    salaryFrom: (from: string) => `from ${from}`,
    salaryTo: (to: string) => `up to ${to}`,
    salaryNet: ' net',
  },

  search: {
    usage: 'Add a query after the command: /search role, company or skill',
    empty: 'Nothing matched among the scored vacancies. Try different words.',
    result: (score: number, name: string, employer: string, applyId: string, url: string, open: string) =>
      `<b>${score}/100 — ${name}</b>\n${employer} · <code>${applyId}</code> · <a href="${url}">${open}</a>`,
    noVacancy: (reference: string) => `No scored vacancy has the ID ${reference}.`,
    ambiguous: (reference: string) => `The prefix ${reference} matches several vacancies. Send more letters.`,
    vacancyCard: (name: string, employer: string, applyId: string) =>
      `<b>${name}</b>\n${employer} · <code>${applyId}</code>`,
  },

  application: {
    artifacts: {
      cv: { button: '📄 CV', loader: 'Tailoring the CV', sending: 'Sending the CV', noun: 'CV' },
      letter: { button: '✉️ Letter', loader: 'Writing the letter', sending: 'Sending the letter', noun: 'cover letter' },
    },
    skipButton: 'Skip',
    skippedToast: 'Vacancy skipped',
    retryButton: 'Try again',
    busyToast: 'Wait for the current task first',
    cvCaption: (name: string) => `Tailored CV — ${name}`,
    cvLimit: (limit: number) => `The daily tailored-CV limit (${limit}) is spent. A letter can still be written.`,
    letterLimit: (limit: number) => `The daily cover-letter limit (${limit}) is spent.`,
    withId: (message: string, applyId: string) => `${message} ID: ${applyId}.`,
    gone: (applyId: string) => `Vacancy ${applyId} is no longer available for document preparation.`,
    storeUnavailable: (applyId: string) => `Temporary database error for vacancy ${applyId}. Send the ID again.`,
    failed: (noun: string, applyId: string) =>
      `The ${noun} for vacancy ${applyId} could not be prepared. Send the ID again or press the button.`,
  },

  workflow: {
    kinds: {
      'cv-import': 'uploading and reading the CV',
      'profile-refresh': 'preparing search settings from the CV',
      'tailored-cv': 'preparing a tailored CV',
      'cover-letter': 'writing a cover letter',
    },
    unknownKind: 'another CV or document task',
    busy: (active: string, requested: string) =>
      `Already running: “${active}”. The request “${requested}” was not started.\n\n`
      + 'Only one such task runs at a time per user. Pressing again does not queue anything and does not start '
      + 'additional language-model calls. Wait for the message that reports success or failure, then ask again.',
  },

  personalData: {
    confirmPrompt: 'This permanently deletes your CV, search settings, scores, decisions, stored applications, '
      + 'statistics, delivery settings and your chosen interface language. The shared vacancy database stays. '
      + 'Send /delete_me confirm to confirm.',
    busy: 'A task is running on your CV or an application right now. Wait for its final message, then delete again.',
    deleted: 'Your personal data has been deleted, your interface language included: the bot will follow your '
      + 'Telegram language again until you pick one with /language. Bot access is unchanged — upload a new CV '
      + 'with /cv.',
    privacy: 'How your data is handled:\n\n'
      + '• The private database stores your CV text and structure, search settings, numeric scores, statistics, '
      + 'delivery state and your chosen interface language.\n'
      + '• CV and vacancy text is sent to the configured language model for search, scoring and application drafts.\n'
      + '• To run identical searches once, search wordings — never your name, contacts or CV text — are shared among '
      + 'the users of this deployment; a wording may be suggested, without attribution, when a search profile is '
      + 'generated for another user.\n'
      + '• The uploaded file itself and finished model conversations are not kept. So a finished application can be '
      + 'resent, the cover-letter text and the Telegram file_id of the tailored PDF are stored; the PDF itself is '
      + 'not kept in the database.\n'
      + '• The explanation behind a high score is kept only until the alert is sent.\n'
      + '• Export, including stored applications: /export_me. Full deletion: /delete_me confirm.\n\n'
      + 'By uploading a CV through /cv you agree to this processing.',
  },

  commands: {
    start: 'Getting started and status',
    request: 'Request access',
    cv: 'Upload or replace your CV',
    privacy: 'How your data is handled',
    window: 'Set your alert hours',
    digest: 'Daily digest state',
    search: 'Search the scored vacancies',
    language: 'Interface language',
    export_me: 'Export your data',
    delete_me: 'Delete your data',
  },
};
