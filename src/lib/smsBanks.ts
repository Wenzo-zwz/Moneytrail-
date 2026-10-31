export type SmsBankCode = "icbc" | "abc" | "boc" | "ccb";

interface SmsBank {
  code: SmsBankCode;
  name: string;
  signatureNames: string[];
  senderExamples: string[];
  reviewOnly: boolean;
}

export const SMS_BANKS: readonly SmsBank[] = [
  { code: "icbc", name: "工商银行", signatureNames: ["工商银行"], senderExamples: ["95588"], reviewOnly: false },
  {
    code: "abc", name: "农业银行", signatureNames: ["中国农业银行", "农业银行"],
    // Official sender notice, 2025-08-27: https://www.abchina.com/cn/PersonalServices/SvcBulletin/202508/t20250827_2458070.htm
    senderExamples: ["95599", "1069095599", "10690955998"], reviewOnly: true,
  },
  {
    code: "boc", name: "中国银行", signatureNames: ["中国银行"],
    // Official transaction notice: https://www.boc.cn/bcservice/bi2/202403/t20240327_24804813.html
    senderExamples: ["95566"], reviewOnly: true,
  },
  {
    code: "ccb", name: "建设银行", signatureNames: ["中国建设银行", "建设银行"],
    // Official sender FAQ: https://creditcard.ccb.com/faq/20111126_924470564/questionlist_1.html
    senderExamples: ["95533", "106980095533"], reviewOnly: true,
  },
];

export function getSmsBank(code: SmsBankCode): SmsBank {
  const bank = SMS_BANKS.find(bank => bank.code === code);
  if (!bank) throw new Error("不支持的短信银行");
  return bank;
}
