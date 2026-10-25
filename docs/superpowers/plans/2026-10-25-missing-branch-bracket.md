# Missing branch bracket repair

User-authorized bugfix: recognize the pending billiards payment when safe; leave the ambiguous WeChat transfer for manual confirmation.

Root cause: the original ICBC message has complete ASCII bank parentheses, but its merchant contains one unmatched fullwidth opening bracket in a branch name. NFKC turns both openings into ASCII and the existing balanced-bracket guard correctly rejects it. Preserve that guard and perform only a narrowly matched repair before normalization.

1. Add failing TS/manual-parser and PostgreSQL tests using synthetic merchants. Accept only one unmatched fullwidth branch opening, a branch label ending in 店/门店/分店/营业部/支行/分行 (1–40 characters), and a complete ICBC debit suffix with independent amount and optional balance. Missing other brackets, multiple events/amounts, ambiguous transfers and group collections remain protected.
2. Add a pure TS repair helper and an append-only SQL migration with the same predicate. Add 台球/桌球 to 娱乐 in both classification implementations. Keep all other parser and classification behavior unchanged.
3. Run focused failures then full tests/typecheck/build; request independent review and resolve findings. Apply the reviewed migration, merge/publish the reviewed code, and verify hosted parsing and deployed assets.
4. Back up the identified account's ledger and affected inbox rows. Explicitly selected processing applies only the repaired 88-yuan expense after preview. Verify one new 娱乐 transaction, original transaction fields and the ambiguous transfer untouched, and no eligible duplicate remains.

Do not commit raw bank texts, card tails, user identifiers or recovery snapshots; use .git/codex-sdd for private evidence. Do not invent missing merchant names, dates, amounts or transaction purposes.
