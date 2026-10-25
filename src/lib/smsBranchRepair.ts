// Repair a single missing fullwidth branch close only inside a complete ICBC
// envelope. The strict parser still checks dates, amounts, events and purpose.
const branchEnvelope = new RegExp(String.raw`^(尾号[0-9xX*]{4}卡(?:[0-9]{4}年)?[0-9]{1,2}月[0-9]{1,2}日[0-9]{1,2}:[0-9]{2}支出\()([^()（）\r\n]{1,160})（([^()（）\r\n]{1,40})(\)(?:[0-9]{1,20}|[0-9]{1,3}(?:,[0-9]{3}){1,6})(?:\.[0-9]{1,2})?元(?:[，,]余额(?:[0-9xX*]{1,20}|[0-9xX*]{1,3}(?:,[0-9xX*]{3}){1,6})(?:\.[0-9xX*]{1,2})?元)?[。.]?【工商银行】)$`);

export function repairMissingBranchBracket(rawText: string): string {
  if (rawText.length > 2048) return rawText;
  const text = rawText.trim();
  const match = branchEnvelope.exec(text);
  if (!match || !/(?:店|营业部|支行|分行)$/.test(match[3])) return rawText;
  return `${match[1]}${match[2]}（${match[3]}）${match[4]}`;
}
