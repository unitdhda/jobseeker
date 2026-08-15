## Purpose

Defines the user-visible journey from an approved Telegram user's CV submission through profile-derived vacancy discovery, fit evaluation, and non-duplicative delivery.

## ADDED Requirements

### Requirement: Approved users can submit supported CV files
The system SHALL allow an approved user to submit a PDF, DOCX, Markdown, or plain-text CV within configured safety and size limits. The system MUST reject unsupported, mismatched, unsafe, or unreadable files without replacing the user's current CV.

#### Scenario: Supported CV is extracted
- **WHEN** an approved user submits a valid supported CV
- **THEN** the system extracts its text and structure and presents a confirmation preview with relevant extraction warnings

#### Scenario: Invalid CV is rejected safely
- **WHEN** a submitted file is unsupported, exceeds a limit, has inconsistent format indicators, or cannot yield sufficient readable text
- **THEN** the system reports the failure and preserves the user's current authoritative CV

### Requirement: CV replacement requires confirmation
The system SHALL treat an extracted CV as a temporary preview until the user explicitly confirms it. Confirmation MUST make that extraction authoritative, while rejection or expiry MUST leave the previous authoritative CV unchanged.

#### Scenario: User confirms a preview
- **WHEN** a user confirms a live CV preview
- **THEN** the system stores the extracted CV as authoritative and starts refreshing the user's derived profiles

#### Scenario: User rejects a preview
- **WHEN** a user rejects the staged CV preview
- **THEN** the system discards the preview and retains the prior authoritative CV

### Requirement: The system derives reusable search demand
The system SHALL derive an occupation-neutral career profile and source-specific search profiles from the confirmed CV. Equivalent search demand MAY share discovery work, but matching and delivery MUST remain user-specific and MUST NOT expose one user's CV or identity to another user.

#### Scenario: Profile refresh succeeds
- **WHEN** a confirmed CV has sufficient evidence and configured model providers are available
- **THEN** the system creates validated career and source profiles and subscribes the user to the resulting search demand

#### Scenario: One source profile fails
- **WHEN** profile generation fails for one vacancy source
- **THEN** the system preserves successful profiles for other sources and records or reports the isolated failure without exposing private CV content

### Requirement: Vacancies are matched against each approved user's CV
The system SHALL normalize and globally deduplicate discovered vacancies, then evaluate each vacancy independently against every approved user with a current matching lens. Deterministic evidence SHALL bound expensive scoring, and configured semantic and full scoring SHALL produce a user-specific 0–100 fit score and decision details.

#### Scenario: Vacancy has sufficient evidence
- **WHEN** a normalized, current vacancy has sufficient role or skill evidence for an approved user
- **THEN** the system admits the user-vacancy pair to the configured scoring pipeline

#### Scenario: Vacancy is unrelated or stale
- **WHEN** a vacancy lacks minimum role or skill evidence or exceeds the configured maximum age
- **THEN** the system does not spend a full scoring call on that user-vacancy pair

#### Scenario: User evaluation fails in isolation
- **WHEN** one user's matching lens cannot be loaded or evaluated
- **THEN** matching continues for other approved users

### Requirement: Relevant vacancies are delivered through Telegram
The system SHALL deliver high-scoring vacancies promptly and SHALL make configured mid-range scores available in a digest. Delivered vacancy messages MUST provide enough information to decide whether to inspect, skip, or start an application, including score, summary, reasons, gaps, source link, and application actions where available.

#### Scenario: Vacancy reaches alert threshold
- **WHEN** a scored vacancy reaches the configured alert threshold for an approved user
- **THEN** the system sends that user a Telegram alert and marks it delivered only after Telegram accepts the message

#### Scenario: Vacancy is in digest range
- **WHEN** a scored vacancy falls between the configured digest and alert thresholds
- **THEN** the system includes it in the user's addressable digest according to digest scheduling and pagination rules

#### Scenario: Delivery fails
- **WHEN** Telegram does not accept an alert or digest delivery
- **THEN** the system does not mark the vacancy as successfully delivered

### Requirement: Delivered and dismissed vacancies do not resurface as fresh matches
The system MUST preserve delivery and dismissal memory so that alerted, digested, skipped, applying, or applied user-vacancy pairs cannot become fresh deliverables again merely because discovery, normalization, scoring, or CV refresh runs again.

#### Scenario: Previously delivered vacancy is rediscovered
- **WHEN** a vacancy already delivered to a user is discovered or normalized again
- **THEN** the system retains its delivered state and does not present it as a new match

#### Scenario: User skips a vacancy
- **WHEN** a user skips an alerted or digested vacancy
- **THEN** the system records the dismissal while retaining any permitted later transition into an application flow
