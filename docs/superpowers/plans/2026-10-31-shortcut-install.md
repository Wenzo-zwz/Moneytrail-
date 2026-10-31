# Shortcut Install Onboarding Implementation Plan

> **For agentic workers:** Use subagent-driven-development with scoped ownership and independent review. No database migration or business data write is needed.

**Goal:** Replace manual shortcut construction with a verified template install and short account-bound onboarding guide.

**Architecture:** A pure template contract helper gates the fixed iCloud link by the configured project. A focused setup component consumes existing SmsConfig and refresh callback. The parent retains all secret ownership and lifecycle behavior.

**Tech Stack:** React/TypeScript, existing Supabase SDK calls, Vitest, Playwright fixtures, GitHub Pages.

## Global constraints

- Never put raw tokens, account IDs, SMS or secrets into links/query strings, logs, local storage or public artifacts.
- Do not infer template/automation installation from enabled or last_received_at.
- Do not rotate credentials or write fake transactions as a connection test.
- Preserve legacy manual configuration and custom-deployment behavior.

### Task 1 — Verified template component and contract

Files: create `src/lib/shortcutTemplate.ts` and focused tests; create `src/components/SmsShortcutSetup.tsx`; append scoped style to `src/sms.css`.

Interfaces:
```ts
export const SMS_SHORTCUT_TEMPLATE = {url, name, projectUrl} as const;
export function isShortcutTemplateCompatible(projectUrl: string): boolean;
type Props = {projectUrl: string; config: SmsConfig; busy: boolean; onRefresh: () => void};
```

- [ ] Test fixed HTTPS iCloud link without secret parameters, normalized matching project and rejection of other projects/paths/credentials/query/fragment.
- [ ] Implement minimum helper, then run focused tests GREEN.
- [ ] Render four numbered steps from approved spec. Enabled means only access enabled, not installation proof. Render disabled install control for disabled/custom project. Refresh callback does not write or rotate anything.
- [ ] Style existing dark setting card consistently; all buttons readable at 320px, no overflow.

### Task 2 — Parent integration, documentation and browser proof

Files: `SmsAutomationPanel.tsx`, `docs/sms-automation.md`, browser fixture script/tests as required.

- [ ] Write failing browser fixture for initial enable gate, fixed install href, one-time token modal copy/install, unchanged existing token/ledger after refresh, custom-project guard, owner switch and narrow layouts.
- [ ] Integrate setup below access controls; add fixed install link in token dialog for compatible projects. Preserve secret clear/revoke/owner behavior. Ordinary setup/error copy should not tell customers to create databases.
- [ ] Keep manual setup in existing folded guide; remove fake transaction suggestion from consumer flow and label actual receive verification clearly.
- [ ] Document installer, real SMS trigger/input handoff, old token reuse vs rotation, supported bank scope and verification limits.

### Task 3 — Review and publish

- [ ] Run unit tests/build and relevant SMS/account/classification browser regression. Independent review and fixes.
- [ ] Commit only public code/docs with no downloaded private metadata. Publish PR, merge verified head, wait for matching Pages action.
- [ ] Verify new production main/SMS assets/SW and installer markers/read-only login layout; confirm no database change was performed.
- [ ] Report installer live and static verification, while reserving actual first-install/trigger validation for iPhone user.
