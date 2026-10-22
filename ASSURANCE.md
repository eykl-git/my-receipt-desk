# Assurance checklist: My Receipt Desk

What is built, what is tested, what is assumed, and what a production system would still need. Test IDs: T01–T26 (required domain tests, Vitest), P1–P4 (property tests), K01–K04 (knowledge-assist tests), O01–O03 (currency and OCR tests), E1–E8 (Playwright browser flows). Results of the latest runs are in `.agents/tasks/c21/s7-verification.md`; earlier stages in `s1`–`s6-verification.md`.

This is a prototype. This prototype makes no production security claims, and the list below is evidence, not a certification.

## Implemented controls

- Exact amount and same currency: a receipt and a card transaction match only at the same amount to the cent and in the workspace currency (demo HKD; My files HKD or MYR). No tolerance, no conversion. Built-in, can't be changed by a rule.
- Posting-date window: card posting date 0–3 days on or after the receipt date (demo policy); an approved rule can change it within 0–7 days.
- One-to-one links: one card transaction links to at most one receipt or invoice, enforced in the engine and by a unique IndexedDB index.
- Ambiguity goes to the user: two or more plausible transactions, unclear or unconfirmed fields, and suspected duplicates block automatic matching.
- Re-check before every write: each proposal is revalidated inside the storage transaction that records it; a stale proposal writes nothing.
- Atomic writes: a match, its ledger entry and its audit event are written in one transaction or not at all.
- Explicit knowledge only: rules are created as drafts, checked by `validateDraft`, previewed with `previewImpact`, and active only after "Activate rule". Unknown rule keys are rejected (`UNSUPPORTED_ACTION`); aliases are exact labels within one card account; generic processor labels and wildcards are refused.
- Rule history: approved and discarded versions are immutable; edits create new versions; suspension stops reuse without rewriting recorded entries.
- Untrusted text stays data: receipt text, OCR output, file names and CSV cells are rendered as React text nodes only (`dangerouslySetInnerHTML` is lint-banned) and never decide an action. Only the display formatter reads printed receipt text.
- OCR is proposal-only: OCR results are stored as unconfirmed originals; unclear fields are marked unclear; nothing matches until the user saves the fields. OCR assets load from the site's own origin only.
- Input validation: file extension, MIME type, file signature, size, counts, CSV schema, row values and field lengths are checked against `src/domain/limits.ts` with messages that name the limit. Ambiguous dates need an explicit format.
- Idempotent re-uploads and re-imports by SHA-256.
- Formula-injection escaping in CSV exports; amount and date columns stay typed.
- Export gate: every record is re-validated with zod before an export.
- Bounded batch run: "Record all ready" handles up to 50 cases, can be paused, and never leaves a partial record.
- No external calls: no analytics, telemetry or API keys; a build-time Content-Security-Policy allows the site's own origin only (`'wasm-unsafe-eval'` and `worker-src 'self'` for the OCR worker).
- Deterministic demo: fixed demo clock, stable IDs, no `Math.random` in `src/` (lint-banned).
- Honest copy: every counter and coach sentence is derived from state; a denylist test scans source strings and these docs for overclaims.
- Module boundaries enforced by ESLint `no-restricted-imports` (domain has no React, storage, UI, demo or OCR engine imports; no dynamic `import()` in `src/`).
- Storage failures handled: no IndexedDB → in-memory mode with a banner; quota and abort errors write nothing; a newer database version opens read-only; records that fail validation are listed under "Storage problems".

## Tested controls

Domain tests (Vitest, `tests/unit/`):

- T01 a unique proposal for R-101 with a full check trace; category stays unassigned.
- T02 an unknown card name blocks matching; "Confirm this case only" teaches nothing.
- T03 an approved alias makes later cases ready with the exact rule version; recorded entries unchanged; category preference sub-case.
- T04 an alias doesn't apply on another card account.
- T05 no amount or currency override, including manual resolution.
- T06 posting-date window boundaries (−1, 0, 3, 4 days; month, year and leap-day edges).
- T07 missing or unvalidated fields block matching.
- T08 ambiguity holds with and without the alias; the first row is never picked.
- T09 competing receipts never share a transaction; a second link raises `AlreadyLinkedError`.
- T10 re-uploads, re-imports and repeated batch loads are idempotent.
- T11 genuine repeat purchases are kept and flagged on the newer, unlinked side only (M1, N10).
- T12 a statement-only entry gains its receipt as evidence without a second entry.
- T13 an unpaid invoice is not counted as paid until a payment links once.
- T14 blocked drafts report exact codes; schema failures write nothing; draft persistence and edit sub-cases.
- T15 stale proposals are refused inside the write.
- T16 suspension stops reuse and keeps history; void and unlink sub-cases.
- T17 malformed CSV imports report row, column and value; nothing partial is written.
- T18 formula-injection escaping in ledger and exceptions CSVs; typed columns stay unprefixed.
- T19 instruction-like text in receipts, OCR output, file names and CSV cells changes no rule, approval, match or ledger entry.
- T20 persistence across reopen; "Reset demo" keeps My files; delete all; schema migration.
- T21 every command writes its audit events with affected IDs and rule versions (M3).
- T22 no double counting in totals; category confirmation updates receipt and ledger together.
- T23 every counter and coach sentence of the tour is derived from state, on both the teach and apply-once paths (N1, N2).
- T24 pause stops "Record all ready" between records with no partial record; at most 50 per run.
- T25 an injected storage fault leaves no match, ledger or audit record; batch-load faults leave the tour step unchanged (M3).
- T26 the comparison replay is deterministic, writes nothing and gives 7 vs 3 of 11.

Property tests: P1 money round-trips and integer sums; P2 importing the same CSV k times equals once; P3 random command sequences never double-link a transaction (domain and IndexedDB index); P4 order independence and no shared transaction across proposals.

Knowledge assist: K01 knowledge-gap discovery writes nothing and counts real preview impact; K02 the plain-English phrase parser handles only its documented patterns and refuses safety-check phrases; K03 similarity only orders candidates and changes no outcome; K04 the store-number alias match type and its `OVERBROAD` checks.

Currency and OCR: O01 MYR workspace matching, HKD rejected there, currency locked once data exists, demo locked to HKD; O02 the real OCR engine on the three fictional sample PNGs (the Hong Kong merchant is asserted unclear, not guessed); O03 the receipt text parser across English, Malay and both Chinese scripts, including totals exclusions, ambiguous dates and an instruction-like line that has no effect. Also OL01–OL07 (locale evidence), OA01–OA05 (OCR adapter), OE01–OE11 (engine timeouts, cancel and asset failures).

Supporting tests: COPY denylist (source strings, README.md, ASSURANCE.md, generated KNOWLEDGE.md and CSVs), T-index (T01–T26 all exist), fixture agreement (receipt images match their fixtures; R-104 has no amount), performance guard (500 receipts × 2,000 transactions under 200 ms median), limits tests, hosting test (no absolute asset paths).

Browser flows (Playwright, Chromium):

- E1 the full tour with every counter and coach sentence, the activation summary then badges (M2), boundaries, compare, "Record all ready", at most 15 actions, axe scans, a keyboard-only pass and the 390 px tabs.
- E2 apply once vs teach.
- E3 card CSV import: example file, exact preview, malformed file blocked, re-import refused.
- E4 manual entry, a renamed text file refused, and "Read automatically" on the Hong Kong sample with fields left unconfirmed.
- E5 rule suspension, its preview and history.
- E6 exports: BOM, headers, typed columns and `'` prefixes.
- E7 the Pages build under `/my-receipt-desk/`: same-origin requests only, no CSP errors, works offline after load, tour completes; screenshots at four sizes; OCR on the Pages build.
- E8 persistence, reload at step 2, reset and delete all.
- S5 newer-version banner (`tests/e2e/s5-integrity.spec.ts`, "S5 newer-version banner: one click deletes nothing; only the confirmed Delete removes that workspace"): a My files database saved by a newer version shows the banner, leaves the data unchanged, and only the confirmed Delete removes that workspace while the demo is kept.

CI and dependencies: `npm audit --audit-level=high` runs locally and in `ci.yml`; both workflow files pass `actionlint`.

## Untested assumptions

- The workflows have not run on GitHub; the Pages deployment, the `VITE_BASE` expression for `<owner>.github.io` repositories and the published URL are unverified until the first push.
- `vite preview` stands in for GitHub Pages; Pages' own headers and caching are not tested.
- Browsers other than Chromium (Firefox, Safari, mobile browsers) are untested.
- Reduced motion is implemented in CSS but not emulated in a browser test.
- Full WCAG conformance is not established: axe covers automated A/AA rules only, and no manual assistive-technology testing or expert review has been done. The keyboard pass doesn't cover the CSV wizard or the OCR box.
- OCR results come from clean fictional renders. Real thermal receipts, photos at an angle and Chinese text will read worse; that has not been measured.
- Known console warnings: loading the Traditional Chinese OCR model logs about eight "Warning: Parameter not found: " console errors. They are assumed harmless because OCR results are unchanged; the browser tests allow exactly that prefix during OCR.
- Storage quota behaviour and eviction on real devices are simulated in unit tests (fake-indexeddb and injected faults), not observed in browsers.
- The "Storage problems" panel is unit-tested and wired but not driven in a browser test.
- Memory and speed on low-end devices with the full workspace limits are untested in a browser.

## Production gaps

- Authentication, multiple users and real segregation of duties: approval by the single local owner shows intent and provenance only.
- The local audit log is inspectable but not tamper-proof. Production needs an append-only, server-side, signed log.
- Server-side storage, backup, sync and retention policies; today clearing the browser loses the data.
- Encryption at rest beyond what the browser and OS provide; protection on shared devices.
- Bank feeds, accounting-system integration, currency conversion, split and partial payments, refunds and credit notes.
- A service worker for cold offline reloads; code splitting with an offline cache.
- Monitoring, error reporting and incident response (deliberately absent here: no telemetry).
- Repository protection: branch protection or rulesets requiring CI before merge, required reviews, and a limited `github-pages` environment are GitHub settings that files can't enforce.
- Dependency maintenance: automated update and audit alerts; a review of the OCR engine's licences and supply chain.
- Real-receipt OCR evaluation, image preprocessing and a human review queue sized for real volumes.
- Independent security review and penetration testing, and a full accessibility audit with assistive-technology users.
