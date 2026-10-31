# Four-bank SMS intake

User scope: initially register ICBC, ABC, BOC and CCB, using the agreed phone forwarding + server parsing + existing category rules. WeChat/Alipay app notifications remain a separate later task.

## Behavior

- Keep the current ICBC parser and automatic posting behavior intact.
- Accept debit/expense messages with one unambiguous four-bank signature, excluding security codes before saving anything. Recognize full bank names including 中国农业银行/农业银行 and 中国建设银行/建设银行. Unknown or multiple bank claims must be rejected.
- Initially treat the three newly registered banks as review-only until current real-device samples are verified. Extract bounded official historical ABC credit-card and CCB debit-account variants into editable drafts; BOC and other unknown layouts enter the inbox without guessed transaction fields. Do not advertise full automatic support merely from a registered bank name.
- Missing merchant/date/time, uncertain transfers, group collections, refunds, reversals and failed payments remain pending. No balance may become an expense amount.
- Preserve original-bank text for masked evidence, account isolation, raw-text deduplication, quotas, merchant memory and explicit confirmation. Do not rewrite any existing ledger, inbox, token or merchant rule during migration.

## Sources and confidence

- ABC official historical credit-card example: https://www.abchina.com/cn/creditcard/xykts/201602/W020200724518582815201.pdf — month/day + HH:mm + consumption amount + available balance, no merchant.
- CCB historical Beijing debit-account example (2010): https://e.ccb.com/chn/2010-06/23/article_2021082106133178863.shtml — month/day + HH时mm分 + business description 批扣 + amount + balance. This cannot establish current whole-bank coverage.
- BOC transaction notices: https://www.boc.cn/bcservice/bi2/202403/t20240327_24804813.html — sender confirmed, no verifiable mainland body template found; retain unknown layouts for manual review.
- Sender references: ABC https://www.abchina.com/cn/PersonalServices/SvcBulletin/202508/t20250827_2458070.htm ; BOC https://www.boc.cn/ebanking/security/tips/201302/t20130205_2152054.html ; CCB https://creditcard.ccb.com/faq/20111126_924470564/questionlist_1.html . Display these as examples, always select actual SMS sender.

## Implementation boundaries

Add a private bank classifier and dispatcher. Route account parsing through it, and use it for the original-merchant guard during confirmation. Keep the public receive RPC signature unchanged; replace only its scope validation and parser route. No new authentication mechanism, ledger fields or public table access.

The published iCloud shortcut remains ICBC-only. Its bank and 支出 filters cannot be changed remotely by this environment. Keep its fixed installer truthful; add bank selection and explicit manual instructions for newly registered banks. Explain that existing token/request/notification sections can be reused, with bank-specific forwarding configuration. Do not imply that installing the old template forwards the other three banks.

## Verification

TDD against real PGlite: four-bank admission, unsupported rejection, review-only new banks, official historical bounded drafts, amount/balance separation, strict dates, future/old times, original evidence redaction, account/token/dedup behavior and migration data preservation. Browser fixtures cover bank switching, old installer visibility, custom deployment guard, read-only refresh and 320px layout. Apply the reviewed migration, verify live parser results read-only and compare data fingerprints before/after, then publish and check production assets. Physical iPhone forwarding and current bank templates remain explicitly unverified until samples arrive.
