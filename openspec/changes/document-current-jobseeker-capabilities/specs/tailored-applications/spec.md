## Purpose

Defines safe, on-demand creation and Telegram delivery of vacancy-specific CVs and cover letters grounded in the user's confirmed CV evidence.

## ADDED Requirements

### Requirement: Users can request either application artifact independently
The system SHALL allow an approved user to request a tailored CV or a cover letter for an addressable matched vacancy. Each artifact type MUST have an independent generation result and configured usage limit.

#### Scenario: User requests a tailored CV
- **WHEN** an approved user requests a tailored CV for an addressable vacancy
- **THEN** the system starts or reuses the tailored-CV workflow without requiring a cover letter

#### Scenario: User requests a cover letter
- **WHEN** an approved user requests a cover letter for an addressable vacancy
- **THEN** the system starts or reuses the cover-letter workflow without requiring a tailored CV

### Requirement: Generated artifacts are grounded in authoritative CV evidence
The system MUST generate application artifacts from the user's current authoritative CV and the selected vacancy. A tailored CV MUST only select, reorder, or faithfully paraphrase supported evidence and MUST reject invented metrics, employers, institutions, contacts, or named skills. A cover letter MUST use concrete supported CV evidence and MUST NOT invent qualifications.

#### Scenario: Tailored CV passes evidence validation
- **WHEN** generated tailored-CV content contains only claims supported by the authoritative CV
- **THEN** the system renders it as a PDF for delivery

#### Scenario: Generated CV invents evidence
- **WHEN** generated tailored-CV content introduces an unsupported factual claim
- **THEN** the system rejects the artifact and does not deliver it as a successful application document

#### Scenario: Cover letter is generated
- **WHEN** cover-letter generation succeeds
- **THEN** the system produces concise plain text in the vacancy language using supported CV evidence

### Requirement: Application generation is bounded and serialized per user
The system SHALL enforce configured generation limits and SHALL prevent concurrent expensive workflows for the same user from starting duplicate model calls. A failed workflow MUST release or expire its ownership so the user can try again.

#### Scenario: Duplicate action is received
- **WHEN** a user repeats an artifact action while an expensive workflow is already active
- **THEN** the system reports that work is in progress and does not start another generation call

#### Scenario: Usage limit is exhausted
- **WHEN** the user has reached the configured daily limit for the requested artifact type
- **THEN** the system refuses new generation for that type without consuming another model call

### Requirement: Artifacts are cached against the current CV
The system SHALL cache each successfully delivered artifact against the authoritative CV hash. Repeating the same request with the same CV hash MUST reuse the cached Telegram file identifier or text without another model call or usage charge; a changed CV hash MUST require regeneration.

#### Scenario: Same-CV tailored CV is requested again
- **WHEN** a delivered tailored CV is requested again and the authoritative CV hash is unchanged
- **THEN** the system resends the cached artifact without regenerating it

#### Scenario: CV changed after prior generation
- **WHEN** an artifact is requested after the authoritative CV hash changes
- **THEN** the system does not reuse the stale artifact and starts a newly bounded generation workflow

### Requirement: Successful artifacts are delivered through Telegram
The system SHALL deliver tailored CVs as PDF documents and cover letters as text through the requesting user's Telegram chat. It MUST record successful application delivery only after Telegram accepts the artifact.

#### Scenario: Tailored CV delivery succeeds
- **WHEN** Telegram accepts the generated tailored-CV PDF
- **THEN** the system records the artifact cache and the match's successful application delivery state

#### Scenario: Artifact delivery fails
- **WHEN** generation succeeds but Telegram delivery fails
- **THEN** the system does not record the artifact as successfully delivered

### Requirement: Generated binary content is not retained as application storage
The system MUST NOT persist uploaded source-file bytes or generated PDF bytes in PostgreSQL. It MAY retain authoritative extracted CV content, artifact metadata, cover-letter text, and Telegram file identifiers needed for documented operation and export.

#### Scenario: Tailored CV PDF is delivered
- **WHEN** a tailored CV PDF has been generated and sent
- **THEN** persistent application storage contains no copy of the generated PDF bytes
