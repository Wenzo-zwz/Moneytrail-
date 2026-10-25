# Meituan Purpose Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop inferring dining from Meituan alone, recognize common recreation merchants, and correct the owner's affected historical SMS expenses without changing unclear transfers.

**Architecture:** Keep keyword inclusion matching and exact personal merchant rules. A narrow platform-only identity guard precedes personal overrides, so shared Meituan platform names remain uncategorized ordinary expenses. Mirror TypeScript classification and private Postgres functions in an append-only migration, retaining parser and intake safeguards.

**Tech Stack:** TypeScript, React, Vitest, PGlite, PostgreSQL/Supabase, GitHub Pages.

## Global Constraints

- User approved the design and authorized database updates, historical corrections, and web publishing on 2026-10-25.
- Group collections, ambiguous transfers, refunds, malformed messages, and duplicate checks retain existing review behavior.
- Plain `烟酒` already means shopping; do not require the compound `烟酒副食`.
- Add clear recreation terms including massage, foot bath, SPA, scripted role-play, and escape rooms; medical merchant context retains its existing priority.
- Shared platform names cannot be remembered as a single permanent category; existing overrides must not bypass the guard. Deletion of old platform rules stays possible.
- No private transaction text, account IDs, or backups in tracked files. Store recovery/audit artifacts only in `.git/codex-sdd/`.
- Historical changes must be scoped to the verified owner and exact reviewed records, preserve all other fields, and abort if the ledger changes.

### Task 1: Frontend classification and merchant rules

**Files:** `src/lib/merchantClassification.ts`, `src/lib/merchantClassification.cases.json`, `src/lib/merchantClassification.test.ts`, `src/lib/smsClient.ts`, `src/components/SmsClassificationTools.tsx`, corresponding client/UI tests.

- [ ] Write failing cases for platform-only expenses, old platform overrides, new recreation terms, and plain tobacco/grocery terms.
- [ ] Run `npm test -- src/lib/merchantClassification.test.ts` and observe expected failures.
- [ ] Remove the Meituan dining fallback, add the narrow platform-only guard and recreation terms, and prevent saving platform-only personal rules while permitting deletion.
- [ ] Keep known-purpose Meituan merchants classified by their purpose, not by platform.
- [ ] Run targeted tests and share the exact platform helper semantics with backend implementation.

### Task 2: Postgres parity and automatic intake

**Files:** CLI-generated `supabase/migrations/*_sms_meituan_purpose.sql`, `src/lib/smsClassificationDatabase.test.ts`, dedicated purpose migration tests if useful.

- [ ] Write failing integration cases for ordinary platform-only intake recording as `待分类`, recreation intake, legacy personal overrides, rule rejection/deletion, account isolation, and protected transfers.
- [ ] Generate the migration using `npx supabase migration new sms_meituan_purpose`.
- [ ] Mirror frontend classification/helper and account-rule guard in private functions; preserve privileges and public RPC ownership checks.
- [ ] Do not alter recorded transactions as part of schema migration.
- [ ] Run targeted database tests, including shared TS/SQL cases.

### Task 3: Historical audit and owner-scoped correction

**Artifacts:** Private recovery snapshot, explicit reviewed change set, validation script, and result evidence in `.git/codex-sdd/`.

- [ ] Read current owner ledger, pending inbox, merchant rules, and old function definitions into a private recovery file.
- [ ] Identify SMS expenses with Meituan/platform descriptions or newly recognized recreation purposes; compare old/new categories and preserve unrelated/manual records.
- [ ] Inspect exact candidates; platform-only records previously categorized by the old default become `待分类`, while purpose-specific records use the verified purpose category.
- [ ] Validate the exact transactional update locally on the backup in PGlite, including stale-data rejection and unchanged transfer assertions.
- [ ] After deployment, apply only the reviewed owner-scoped correction with revision/data checks and verify unchanged fields, unchanged inbox, no duplicate entries, and remaining pending transfers.

### Task 4: Review, release, and report

- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and appropriate classification/SMS browser checks; perform independent review.
- [ ] Apply the migration, verify live classification/intake invariants read-only and inspect security advisors.
- [ ] Push the feature branch, create and merge a reviewed PR, and verify successful GitHub Pages deployment and actual new production assets.
- [ ] Summarize current keyword groups, ambiguity limits, actual history correction counts, and preserved review items for the user.
