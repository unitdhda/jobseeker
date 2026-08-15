## Context

See `proposal.md` for motivation. The repository already implements the covered workflows across five domain/application packages and documents them in the root README plus `docs/implementation-from-scratch/`. There are currently no main OpenSpec capabilities, so this change establishes a behavioral baseline rather than designing a replacement architecture.

The baseline must remain implementation-independent while respecting existing cross-cutting constraints: PostgreSQL is the runtime store, Telegram is the user and owner interface, source extensions own concrete vacancy catalogues, AI roles are provider-configurable, sensitive content is not logged, and delivered-state memory prevents duplicate delivery.

## Goals / Non-Goals

**Goals:**

- Translate current externally observable behavior into testable normative requirements.
- Organize the baseline into stable capability boundaries suitable for future delta changes.
- Verify that code, tests, and public/operational documentation agree with the new requirements.
- Preserve existing privacy, safety, ownership, and failure-isolation guarantees while describing user and owner journeys.

**Non-Goals:**

- Redesigning the matching pipeline, Telegram UX, persistence model, source runtime, or AI prompts.
- Adding a second administrative interface or changing Telegram ownership semantics.
- Introducing database migrations or altering production data.
- Claiming unimplemented behavior merely because it would be desirable.
- Reproducing internal APIs and algorithms in the behavioral specs.

## Decisions

### Treat implementation plus tests as evidence, not as the spec structure

Each normative requirement is expressed in terms of observable inputs, outputs, safety boundaries, and failure behavior. During conformance review, implementation files, tests, and documentation provide evidence that the behavior exists.

Alternative considered: copy the implementation assignment directly into OpenSpec. Rejected because it mixes internal architecture and function-level detail with product contracts, making harmless refactors appear to change capabilities.

### Split the baseline into three lifecycle-oriented capabilities

The baseline uses:

- `cv-vacancy-matching` for the journey from CV intake through vacancy delivery;
- `tailored-applications` for evidence-bound artifact generation and caching;
- `telegram-administration` for owner identity, access control, and operational reporting.

This keeps future changes localized while making the boundary between ordinary user workflows and owner-only visibility explicit.

Alternative considered: one large `jobseeker` capability. Rejected because most future changes would modify an oversized spec and obscure which contract changed.

### Make apply a conformance audit before any corrective edits

Implementation work begins by mapping every requirement and scenario to existing code, deterministic tests, and documentation. Existing coverage is reused. Only confirmed gaps result in test or documentation edits, or in narrowly scoped code corrections required to make current documented behavior true.

Alternative considered: create new implementation tasks for every requirement. Rejected because the behavior is already implemented and duplicate construction would increase regression risk.

### Preserve strong safety requirements in the behavioral baseline

The specs retain externally meaningful guarantees around CV confirmation, evidence grounding, no duplicate delivery, workflow serialization, artifact-byte retention, owner authorization, report redaction, and delivery acknowledgment. These are observable trust boundaries even though their mechanisms remain implementation details.

Alternative considered: specify only happy-path product features. Rejected because privacy and failure semantics are central to operating a service that handles CVs, credentials, and model-generated application material.

### Use existing validation layers as acceptance evidence

Conformance is validated through targeted package tests, the root deterministic suite, type checking, and OpenSpec strict validation. PostgreSQL integration tests are used where repository lifecycle behavior cannot be proven deterministically without a database.

Alternative considered: rely only on manual Telegram checks. Rejected because manual checks are difficult to reproduce and insufficient for race, persistence, and privacy guarantees.

## Risks / Trade-offs

- [The baseline accidentally promises behavior not currently implemented] → Trace every scenario to code and tests during apply; revise the planning artifact rather than silently expanding product scope when intent is unclear.
- [Implementation details leak into capability contracts] → Keep package names, function names, schemas, and algorithms in design/tasks evidence maps rather than normative requirements.
- [Broad baseline produces unnecessary code churn] → Prefer adding missing tests or correcting documentation; edit runtime code only for a verified mismatch with already documented current behavior.
- [Existing tests assert internals but not observable outcomes] → Add focused scenario-level tests at the nearest existing test boundary.
- [Operational reports expose sensitive data while satisfying visibility requirements] → Preserve bounded and redacted summaries and test escaping, empty states, and oversized output.
- [Database-backed scenarios cannot be validated in every environment] → Keep deterministic tests as the default gate and run the dedicated PostgreSQL integration gate only against an explicitly configured test database.

## Migration Plan

1. Build a requirement-to-evidence matrix covering code, tests, and documentation.
2. Run targeted deterministic tests and strict OpenSpec validation.
3. Close confirmed coverage or documentation gaps without changing intended behavior.
4. Run typecheck and the complete deterministic test suite; run the PostgreSQL integration suite when a safe test database is configured.
5. Archive the validated change so the three delta specs become the initial main OpenSpec baseline.

No production data migration or deployment sequencing is required. If conformance work reveals that a requirement does not describe current intended behavior, roll back the corrective edit and update the planning artifact before proceeding.
