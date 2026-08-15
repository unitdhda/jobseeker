## Purpose

Defines the configured Telegram owner's access to ordinary user workflows, user administration, and privacy-safe operational visibility into the running Jobseeker service.

## ADDED Requirements

### Requirement: The configured owner is an approved user and administrator
The system SHALL recognize the configured Telegram owner as approved and SHALL preserve the owner's approved status. The owner SHALL have access to normal approved-user capabilities in addition to owner-only administrative commands.

#### Scenario: Owner uses a normal user workflow
- **WHEN** the configured owner submits a CV, views matches, or requests an application artifact
- **THEN** the system handles the request under the same user-facing requirements as another approved user

#### Scenario: Administrative action targets the owner
- **WHEN** an administrative action would reject or revoke the configured owner
- **THEN** the system preserves the owner's approved access

### Requirement: The owner can administer user access
The system SHALL allow only the configured owner to list users and approve or revoke access. Non-owner users MUST NOT gain access to owner-only commands or their data.

#### Scenario: Owner lists users
- **WHEN** the owner requests the user administration view
- **THEN** the system returns a bounded view of registered users and their access states

#### Scenario: Owner changes a user's access
- **WHEN** the owner submits a valid approve or revoke action for a non-owner user
- **THEN** the system applies the requested access transition and reports the result

#### Scenario: Non-owner invokes an administrative command
- **WHEN** a non-owner attempts to use an owner-only command
- **THEN** the system denies the administrative operation without disclosing administrative data

### Requirement: The owner can inspect AI usage
The system SHALL provide the owner with a bounded operational summary of AI usage, including totals and trends over the supported reporting period. The report MUST NOT reveal credentials, CV text, vacancy bodies, generated application content, or other private prompt content.

#### Scenario: Owner requests usage status
- **WHEN** the owner invokes the usage command
- **THEN** the system returns current usage totals and an operational trend summary without sensitive content

#### Scenario: Usage data is empty
- **WHEN** the owner requests usage before any reportable events exist
- **THEN** the system returns a valid zero-activity summary rather than failing

### Requirement: The owner can inspect runtime status
The system SHALL provide a bounded service-status view containing operationally useful process, worker, AI-concurrency, Telegram-ownership, and engine-lane information. Status output MUST exclude secrets and personal content.

#### Scenario: Owner requests current status
- **WHEN** the owner invokes the status command
- **THEN** the system reports the current runtime and lane state using privacy-safe operational metadata

#### Scenario: A subsystem is degraded
- **WHEN** a worker or engine lane reports a failure or unavailable state
- **THEN** the status view identifies the affected subsystem without exposing sensitive error payloads

### Requirement: The owner can inspect scraping activity
The system SHALL provide a scraping summary covering discovery, normalization, matching, and scoring activity, configured source health, shared search-unit cadence or overdue state, and bounded parser-error summaries. Configured sources with zero activity MUST remain visible.

#### Scenario: Owner requests scraping activity
- **WHEN** the owner invokes the scraping-status command
- **THEN** the system returns funnel totals, source rows, search-unit status, and bounded recent error summaries

#### Scenario: Configured source has no activity
- **WHEN** a configured source has produced no reportable activity in the reporting window
- **THEN** the scraping summary includes that source with zero values

### Requirement: Administrative reports are safe for Telegram delivery
The system SHALL escape user-controlled content, split oversized administrative reports on safe boundaries, and bound retained transient command output. Administrative messages MUST NOT log or display environment values, tokens, credentials, CV text, vacancy descriptions, search queries, or application content.

#### Scenario: Administrative report exceeds Telegram's message limit
- **WHEN** a generated owner report is too large for one Telegram message
- **THEN** the system splits it into valid bounded messages without corrupting report lines

#### Scenario: Report data contains user-controlled markup
- **WHEN** an administrative report includes a user-controlled name or other text
- **THEN** the system escapes that content before Telegram renders it
