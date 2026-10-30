# Merchant Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Learn a user's explicit category/detail for a concrete unknown merchant and reuse it consistently across SMS and ledger workflows.

**Architecture:** Extend the existing account rules rather than introduce a second rule system. Persist explicit learning intents alongside the account cache, submit them with ledger CAS in one server transaction, and use a separate atomic SMS confirmation wrapper. Share exact normalization and never fuzzy-merge branches.

**Tech Stack:** React, TypeScript, Supabase Postgres, Vitest/PGlite, Playwright.

## Global Constraints

- Same merchant after known payment prefixes/NFKC normalization only; different branches remain distinct.
- Preserve original transaction merchant, evidence, amount and date. No learning from groups, unclear transfers, channels, platform-only names or cancelled/uncommitted work.
- Keep old two-argument ledger save and category-rule RPCs compatible; new RPC names avoid PostgREST overload ambiguity.
- Private live backups stay in `.git/codex-sdd/`; use synthetic examples in tracked tests/docs.

### Task 1: Classification and rule contracts

Files: `src/lib/merchantClassification.ts`, `smsClient.ts`, `parsers.ts`, related tests.

Interfaces:
```ts
type MerchantRule = { merchant: string; category: string; subcategory?: string };
type MerchantRuleIntent = MerchantRule & { transactionId: string };
canRememberMerchant(merchant: string): boolean;
// existing API accepts an optional detail after the existing signal
setSmsCategoryRule(client, userId, merchant, category, signal?, subcategory?);
confirmSms(client, userId, id, draft, signal?, remember?);
// parseSms gains a trailing rules argument without breaking existing callers
```

- [ ] Add failing tests for channel variants (especially 抖音支付), remembered custom detail/未细分, legacy details, different stores, unsafe/platform merchants and strict RPC validation.
- [ ] Run targeted Vitest tests and observe expected failures, implement normalization/detail changes and new RPC client dispatch, rerun.
- [ ] Read/parse rules for local pasted SMS without storing source text in rules.

### Task 2: Private database rules and atomic write RPCs

Files: new CLI-generated append-only migration, new PGlite database tests.

Interfaces:
```sql
moneytrail_sms_set_merchant_rule(p_merchant text,p_category text,p_subcategory text default null) returns jsonb;
save_moneytrail_ledger_with_rules(p_data jsonb,p_expected_revision bigint,p_rules jsonb) returns setof public.moneytrail_ledgers;
moneytrail_sms_confirm_with_rule(p_id uuid,p_draft jsonb,p_remember boolean) returns jsonb;
```

- [ ] Test detail round trips and TS/SQL normalization parity; check legacy normalized aliases without blindly merging conflicting rows.
- [ ] Test ledger+rules atomicity, expected revision failure, transaction-to-intent validation, limits, owner isolation and privileges.
- [ ] Test SMS confirmation learns only a concrete safe original merchant, cannot rename a group/transfer into a learned merchant, and remains idempotent.
- [ ] Run failing tests, implement nullable detail column, private safety/upsert helpers, account parser override, and authenticated wrapper RPCs. Lock settings before inbox/ledger as existing ingestion does.
- [ ] Keep helpers inaccessible and fixed search_path; preserve old RPC behavior. Run PGlite suite and advisors before release.

### Task 3: Persistent intent delivery and save UX

Files: `accountCache.ts`, `cloudStore.ts`, `cloudClient.ts`, `AccountApp.tsx`, `App.tsx`, SMS classification/automation components, tests.

- [ ] Extend version-1 cache with optional `pendingMerchantRules: MerchantRuleIntent[]`; validate bounds/shape and keep intents only while transaction fields still match. Add optional third saveData argument `{merchantRules?: MerchantRuleIntent[]}`.
- [ ] Test intent survives offline restart and is sent only with matching account/transaction; new edits during in-flight save survive acknowledgement, stale intents do not; cloud conflict/reset does not mispublish rules.
- [ ] Push via the new ledger RPC only when valid intents exist; clear only acknowledged intents, preserving later ones. Ordinary/legacy saves use existing RPC.
- [ ] Transaction editor shows a remember checkbox for safe unknown merchant and an explicit category/detail choice, default enabled on that choice. Save marks intent only after successful local transaction save. Import preview remembers the choice only when committed and selected.
- [ ] Pass account rules to App/local SMS parsing; refresh account rules after successful ledger writes and returning from rule editor, with account-bound abort/cancellation and bounded timeout.
- [ ] SMS confirm passes remember intent atomically; rule editor supports detail and displays normalized merchant preview. Saving a rule invalidates history preview; bulk changes remain previewable and undoable.

### Task 4: Review, release and existing data verification

- [ ] Update SMS automation documentation and meaningful browser workflows: first categorization, cross-channel reuse, rule removal/detail editing, different branch, ambiguity guards, offline persistence.
- [ ] Run `npm test`, `npm run build`, relevant account/SMS/classification/browser smoke checks; independently review diff and resolve important findings.
- [ ] Back up live account/rules privately. Apply reviewed migration via Supabase, verify rule RPC/parser and no unexpected business-row changes.
- [ ] Publish through reviewed PR/main Pages workflow, verify production resources and update takeover.
- [ ] Preview existing待分类 under saved rules and update only known safe matches with snapshot/revision checks; preserve unknown/group transfers. Verify final counts and report concrete result.
