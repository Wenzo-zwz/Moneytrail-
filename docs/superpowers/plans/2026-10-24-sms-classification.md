# SMS classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** 修复日常工行短信识别，自动分类，支持预览后批量处理历史待确认和待分类。

**Architecture:** 新增追加式数据库迁移，保留旧迁移不改；独立的 TS 分类模块负责预览和分类补填。短信设置页通过身份绑定 RPC 管理个人商户规则、预览和处理旧短信，通过既有带版本检查的 CloudStore 保存分类变更。

**Tech Stack:** React 19 / TypeScript / PostgreSQL PLpgSQL / Supabase / Vitest + PGlite / Playwright。

## Global Constraints

- 群收款和用途不明的个人转账继续确认。
- 只给原来“待分类”的消费补分类，保留已有人工分类。
- 预览不写账本；批量入账只处理预览的记录，不能重复增加流水。
- 分类和个人商户规则按账户隔离，不能绕过有效性、查重和同步冲突检查。
- 余额不参与交易金额；支持配对的内嵌括号，拒绝多事件和不配对括号。
- 保留现有短信 RPC 兼容性；新功能缺少迁移时显示升级提示，不阻止旧的收件箱使用。
- 不部署或操作真实账本；所有实际账本整理由用户在界面预览确认。

## Shared interfaces

`src/lib/merchantClassification.ts` exports:

```ts
type MerchantRule = { merchant: string; category: string };
type MerchantClassification = { category: string; reason: string; merchantKey: string; requiresReview: boolean };
merchantKey(merchant: string): string; // NFKC, trim, lowercase, strip payment/action prefixes, retain exact merchant identity; empty for generic/ambiguous/fund-transfer descriptions
classifyMerchant(merchant: string, rules?: MerchantRule[]): MerchantClassification;
type CategoryChange = { id: string; merchant: string; fromCategory: string; toCategory: string; reason: string; before: Transaction; after: Transaction };
planCategoryChanges(data: AppData, rules?: MerchantRule[]): CategoryChange[];
applyCategoryChanges(data: AppData, changes: CategoryChange[], undo?: boolean): AppData; // stale changes throw; no mutations; invalidate affected checked months
```

New authenticated database RPCs:

```text
moneytrail_sms_category_rules() -> {rules: [{merchant, category}]}
moneytrail_sms_set_category_rule(p_merchant text, p_category text /* null deletes */) -> {rules: [...]}
moneytrail_sms_preview_pending() -> {items: [{id, draft: SmsDraft|null, eligible: boolean, reason: string}], recordable_count, pending_count}
moneytrail_sms_apply_pending(p_items jsonb /* [{id, draft}] */) -> {recorded_count, pending_count}
```

Personal rules are exact normalized merchant keys (max 200 per account); unsupported categories, generic channels and group collections are rejected. Apply validates owner, uniqueness, max 200, reparses original SMS and compares draft with preview; concurrent changes fail with 40001 or remain pending for new duplicates. Repeated successful applications never add a second transaction. Existing `moneytrail_sms_reprocess_pending()` keeps its existing return type and safety behavior, with the updated parser and personal-rule support.

## Task 1 — Classification core and manual parser (controller)

Files: create `src/lib/merchantClassification.ts`, `.test.ts`; modify `src/lib/parsers.ts`, `parsers.test.ts`.

- [x] Write failing tests: nested merchant in manual parser, channel normalization, Didi/Meituan/tobacco, platform exceptions, generic channels/group review, explicit merchant memory, non-expense and manually classified protection, no duplicate bulk records and stale/undo conflicts.
- [x] Run targeted tests to observe failure, then implement minimal pure helpers and integrate default categories into manual SMS parsing.
- [x] Verify targeted tests and share exact TS rule predicates with database implementer.

## Task 2 — Database parser, auto intake, rules and preview/apply (database implementer)

Files: create `supabase/migrations/202610240001_sms_classification.sql`, `src/lib/smsClassificationDatabase.test.ts`.

- [x] Write PGlite tests executing all migrations: original tobacco SMS must parse to 2000 cents and 购物, balanced nested/fullwidth parentheses, malformed parentheses, added amount/event rejection.
- [x] Add classifier parity cases, exact account-owned merchant rules and rejection of generic/group rules; permission and account separation checks.
- [x] Add preview non-mutation, reviewed-mode preservation, group/personal transfer preservation, selected-only apply, stale-preview rejection, duplicated/idempotent apply, preservation of budget/existing records and duplicate guards.
- [x] Run failing tests, implement migration, then run the new database suite.
- [x] Keep all old migrations unchanged; replace current intake and reprocess definitions only inside new migration.

## Task 3 — Client and mobile UI (UI implementer)

Files: modify `src/lib/smsClient.ts`, `smsClient.test.ts`, `src/components/SmsAutomationPanel.tsx`, `src/sms.css`; add focused UI smoke script if needed.

- [x] Add failing client tests for new RPC response validation, identity/cancellation, invalid selections and upgrade handling.
- [x] Expose wrappers `fetchSmsCategoryRules`, `setSmsCategoryRule`, `previewPendingSms`, `applyPendingSms` for Shared interfaces above.
- [x] Add pending preview dialog and apply only eligible displayed entries; preserve mode, unsaved-store guards and refresh after server writes. Explicit batch preview/apply is available in both auto and review modes without changing future intake settings.
- [x] Add uncategorized expense preview showing category/reason and updating via CloudStore expected snapshot; support undo with conflict detection and truthful pending/offline sync messaging.
- [x] Add explicit save/delete merchant rules; generic/group descriptions cannot be saved. Prefer a separate small component if panel would grow substantially.
- [x] Verify browser flows at mobile and desktop widths: preview leaves data unchanged, apply/undo, rule save/delete, ambiguous group still pending, late result after account change discarded.

## Task 4 — Integration, documentation, review (controller)

- [x] Compare TS and SQL classification results for shared scenarios; fix discrepancies with regression tests.
- [x] Update `docs/sms-automation.md` and README with exact migration, categories, previews, undo and manual-review boundary.
- [x] Run `npm test`, `npm run typecheck`, `npm run build`; run focused browser integration with fixtures and existing core smoke checks where supported.
- [x] Independent whole-branch code review; resolve consequential findings, rerun covering tests.
- [x] Commit feature and provide reviewable changes plus migration instructions. Do not claim live SQL applied or site deployed.
