# Local Life and Retained Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge dining/recreation into local life, add purpose detail and platform, and retain masked SMS evidence for future entries.

**Architecture:** Extend existing version-1 transactions with optional metadata, preserving legacy imports and old-client metadata. Update TypeScript and SQL classification together; attach masked evidence before each successful SMS append, with normal private-ledger access. Add editable detail fields, expandable monthly detail totals, and read-only evidence in the UI.

**Tech Stack:** TypeScript, React, Vitest, PGlite, Supabase Postgres, GitHub Pages.

## Global Constraints

- Follow field contract in the approved-direction spec `../specs/2026-10-25-local-life-receipts.md`.
- Keep raw pending SMS and safety/duplicate guards; never invent historical raw evidence or specific platform order purposes.
- No private financial data in tracked files; recovery and scoped history scripts go under `.git/codex-sdd/`.
- Work on `feat/local-life-receipts`; parallel agents own separate files. Root integrates and is sole live-service writer.

### Task 1: Transaction model, taxonomy, preservation

- [ ] RED tests for new categories, legacy conversion, optional metadata validation/copy/JSON/CSV roundtrip, redaction, platform defaults and purpose detail.
- [ ] Implement model/classification helpers, optional detail summaries and parser evidence; retain refund semantics and deep stale comparisons.
- [ ] GREEN targeted non-database model and persistence tests.

### Task 2: SQL and SMS processing parity

- [ ] RED integration tests for new metadata payloads and category outputs, all intake/confirm/batch/reprocess evidence paths, legacy compatibility and stale clients.
- [ ] CLI-generate append-only migration; update payload validation/save preservation, classifier, account parsing, rules and SMS appends.
- [ ] Preserve grants/auth and validate metadata sizes and redaction; no data updates in DDL.
- [ ] GREEN database tests and TS/SQL shared cases.

### Task 3: Application and SMS UI

- [ ] Update SMS client validation/metadata confirmation preservation, editor, refund linking, category display/filter, detail totals and evidence disclosure.
- [ ] New category choices only; retain readable old imports, show platform and unresolved detail without forcing confirmation.
- [ ] Update meaningful browser fixtures/checks for detail edit/filter/stats, masked receipt after refresh, backup and protected pending entries.

### Task 4: Historical data and release

- [ ] Back up owner ledger/inbox/rules/function definitions; review deterministic conversion of legacy dining/recreation and known platform entries.
- [ ] Locally replay exact scoped history SQL with revision/hash guards, preserving receipt absence for historical deleted originals.
- [ ] Independent full review; test/typecheck/build/browser checks.
- [ ] Apply migration, verify live behavior/permissions/advisory changes; merge and publish web; apply only reviewed historical changes and verify all protected values.
- [ ] Explain current categories and evidence limits, including lack of order details in platform-only bank SMS.
