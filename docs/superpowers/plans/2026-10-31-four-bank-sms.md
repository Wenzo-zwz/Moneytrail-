# Four-bank SMS Implementation Plan

> For agentic workers: use subagent-driven-development with scoped ownership, TDD and independent review.

**Goal:** Register the four major banks for SMS receipt, with bounded draft extraction and honest per-bank onboarding.

**Architecture:** A private bank dispatcher feeds existing account parsing, confirmation and inbox processing. A public TS bank catalogue drives bank selection and manual setup while retaining the ICBC-only shared template.

**Tech Stack:** PostgreSQL/PGlite, TypeScript/React, Vitest, Playwright, Supabase migrations and GitHub Pages.

## Constraints

- New ABC/BOC/CCB receipt is review-only; existing ICBC automation remains intact.
- Original text is the only source of masked evidence. No invented merchant/time; no live test transactions.
- Keep token/owner validation, limits, deduplication and table privileges. No old financial data rewrite.
- The existing shared iCloud URL is only an ICBC installer, with no personal data in its URL.

## Task 1: Database receipt and bounded parsing

- [ ] Generate a migration using the installed CLI, then add `fourBankSmsDatabase.test.ts` against all migrations. First verify failure from missing `sms_bank_code` / `sms_parse_bank` before implementation.
- [ ] Add `moneytrail_private.sms_bank_code(text) returns text` and `sms_parse_bank(text,timestamptz) returns jsonb`. ICBC delegates unchanged; new banks always require review, extracting only bounded ABC/CCB layouts.
- [ ] Update the existing receive RPC scope check, `sms_parse_for_account` dispatch and `moneytrail_sms_confirm_with_rule` original-merchant check. Test no mutation on applying migration and all existing ICBC tests.
- [ ] Test security-code and foreign/unsupported/ambiguous-bank rejection, missing fields, strict cents/date parsing and masked original-bank evidence.

## Task 2: Bank catalogue and onboarding

- [ ] Add typed `src/lib/smsBanks.ts` catalogue (icbc/abc/boc/ccb, names, signature aliases, example senders, receipt status) with focused tests.
- [ ] Add a bank selection to SmsShortcutSetup, render the old installer only for ICBC. For the other banks render clear review-only status and manual setup, preserving unchanged account token.
- [ ] Update parent copy and manual guide to four-bank scope without falsely relabelling the existing template. Document sender references and template limits.
- [ ] Verify bank switching, strict old-link capability, fixture-only receipt refresh and narrow layout via browser tests.

## Task 3: Review, database update and publication

- [ ] Run unit tests/build and relevant browser regression; independent review, resolve findings.
- [ ] Save live pre-migration fingerprints/backup privately, apply DDL via connected Supabase, verify parser fixtures read-only and unchanged business data; check advisors.
- [ ] Commit only public code/docs, create PR and merge reviewed head. Verify matching Pages deployment and fresh production assets/SW. Report exact supported behavior and remaining physical-device step.
