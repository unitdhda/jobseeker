## Purpose

Allows an approved Telegram user to retrieve any scored match from their history by sending a normalized unique prefix of its six-letter match code.

## ADDED Requirements

### Requirement: Scored matches use the existing vacancy code
The system SHALL use the vacancy's existing globally unique six-letter lowercase code as the match code. It MUST NOT create a second identifier for a user–vacancy match, and code lookup MUST only return vacancies that have a completed score for the requesting user.

#### Scenario: Scored match has a reusable code
- **WHEN** a vacancy has a completed score for a user
- **THEN** the user can address that match using the vacancy's existing six-letter code

#### Scenario: Vacancy is not scored for the user
- **WHEN** a vacancy exists but has no completed score for the requesting user
- **THEN** match-code lookup does not return that vacancy

### Requirement: Approved-user text is routed as a code lookup
The system SHALL treat every non-command private text message from an approved user as a match-code lookup. Existing commands, document handling, callbacks, and non-text media behavior MUST remain unchanged.

#### Scenario: Approved user sends non-command text
- **WHEN** an approved user sends text in a private chat and the text is not a recognized command
- **THEN** the system interprets the text as a match-code prefix

#### Scenario: Approved user sends a command
- **WHEN** an approved user sends a recognized command
- **THEN** the system routes the message through the existing command behavior instead of code lookup

#### Scenario: User sends a CV document
- **WHEN** a user sends a document through the existing CV workflow
- **THEN** the system preserves document handling and does not interpret the document as a match code

### Requirement: Code input is normalized and validated
The system SHALL trim surrounding whitespace and convert letter case to lowercase before lookup. A valid normalized prefix MUST contain from one through six ASCII letters; all other input SHALL receive the localized code-not-found response.

#### Scenario: Uppercase code with whitespace
- **WHEN** an approved user sends `  BQE  `
- **THEN** the system performs lookup using `bqe`

#### Scenario: Invalid code input
- **WHEN** normalized input is empty, longer than six characters, or contains a non-letter character
- **THEN** the system replies that the code was not found without querying or revealing match details

### Requirement: Prefix uniqueness is scoped to the requesting user's scored history
The system SHALL compare a valid prefix against all scored matches belonging to the requesting user. It SHALL resolve the prefix only when exactly one match code begins with it and MUST NOT consider or reveal another user's matches.

#### Scenario: Prefix uniquely identifies a match
- **WHEN** `bqerit` belongs to a scored match for the user and `bqe` matches no other code in that user's scored history
- **THEN** `bqe`, `bqer`, `bqeri`, and `bqerit` each resolve to that match

#### Scenario: Prefix matches multiple codes
- **WHEN** two or more codes in the user's scored history begin with the normalized prefix
- **THEN** the system replies that the prefix is too ambiguous and asks the user to provide more letters

#### Scenario: Prefix matches no scored code
- **WHEN** no code in the user's scored history begins with the normalized prefix
- **THEN** the system replies that the code was not found

#### Scenario: Code belongs only to another user
- **WHEN** a valid code or prefix matches scored history for another user but not the requesting user
- **THEN** the system replies that the code was not found

### Requirement: Vacancy messages emphasize the shortest unique prefix
Every Telegram message that presents a vacancy to a user SHALL display the vacancy's full six-letter code and bold only the shortest leading prefix that uniquely identifies it across all of that user's scored matches at message-render time. The remaining code letters MUST remain visible without bold emphasis so an older message still exposes the full code if later matches make its former prefix ambiguous.

#### Scenario: Three letters are currently unique
- **WHEN** the code is `bqerit` and `bqe` is its shortest unique prefix across the user's scored history
- **THEN** every newly rendered vacancy-bearing message displays the equivalent of `<b>bqe</b>rit`

#### Scenario: One letter is currently unique
- **WHEN** the first letter of a code uniquely identifies it across the user's scored history
- **THEN** the message bolds that first letter and displays the other five letters without bold emphasis

#### Scenario: Full code is required for uniqueness
- **WHEN** a code shares its first five letters with another scored match code
- **THEN** the message bolds all six letters

#### Scenario: A later match changes prefix uniqueness
- **WHEN** a previously displayed shortest prefix becomes ambiguous after another match is scored
- **THEN** the old message still contains the full six-letter code and the full code continues to resolve uniquely

### Requirement: Unique lookup returns an actionable match card
The system SHALL respond to a uniquely resolved code with the formatted full match code, match score, vacancy title, and employer plus exactly three actions labeled Open, Letter, and CV in the user's locale. Open MUST target the stored source vacancy URL, Letter MUST start the existing cover-letter action for that match, and CV MUST start the existing tailored-CV action for that match.

#### Scenario: Unique match is retrieved
- **WHEN** a normalized prefix uniquely resolves to one scored match
- **THEN** the system sends its score, title, and employer with Open, Letter, and CV actions

#### Scenario: User selects Open
- **WHEN** the user selects Open on the retrieved match card
- **THEN** Telegram opens the stored source vacancy URL

#### Scenario: User selects Letter or CV
- **WHEN** the user selects Letter or CV on the retrieved match card
- **THEN** the system invokes the corresponding existing application-generation workflow for the resolved match

### Requirement: Lookup feedback is localized and privacy-safe
The system SHALL localize successful match cards, not-found responses, and ambiguous-prefix responses according to the user's resolved locale. Error responses MUST NOT disclose candidate codes, match counts, or vacancies outside the uniquely resolved result.

#### Scenario: Ambiguous prefix in the user's locale
- **WHEN** a prefix is ambiguous for a user whose locale is English or Russian
- **THEN** the system asks for more letters in that locale without listing matching codes

#### Scenario: Unknown code in the user's locale
- **WHEN** a prefix is invalid or unmatched
- **THEN** the system returns the localized not-found response without disclosing other matches
