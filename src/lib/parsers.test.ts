import { describe, expect, it } from "vitest";
import { parseCsv, parseSms } from "./parsers";
import { validateTransaction } from "./ledger";

const reference = new Date(2026, 9, 22, 9, 30);

describe("bank SMS parsing", () => {
  it("keeps nested merchant brackets and categorizes the tobacco purchase", () => {
    const result = parseSms("尾号xxxx卡10月24日00:59支出(消费财付通-示例商贸（烟酒副食）)20元，余额xxxx.86元。【工商银行】", new Date(2026, 9, 24, 1));
    expect(result.draft).toMatchObject({ amountCents: 2000, merchant: "消费财付通-示例商贸(烟酒副食)", category: "购物" });
  });
  it.each(["滴滴出租车", "美团外卖", "手机话费充值"])("categorizes a common merchant: %s", merchant => {
    const result = parseSms(`尾号xxxx卡10月24日00:59支出(${merchant})20元，余额xxxx.86元。【工商银行】`, new Date(2026, 9, 24, 1));
    expect(result.draft?.kind).toBe("expense");
    expect(result.draft?.category).toBe(merchant === "滴滴出租车" ? "交通" : merchant === "美团外卖" ? "本地生活" : "居住");
  });
  it.each(["消费财付通", "转账财付通-群收款", "转账-张三"])("requires checking ambiguous channels or transfers: %s", merchant => {
    const result = parseSms(`尾号xxxx卡10月24日00:59支出(${merchant})20元，余额xxxx.86元。【工商银行】`, new Date(2026, 9, 24, 1));
    expect(result.requiresReview).toBe(true);
  });
  it.each(["支出(烟酒(副食)20元", "支出(烟酒))20元", "支出(烟酒(副食)))20元"])("rejects unbalanced ICBC merchant brackets: %s", body => {
    const result = parseSms(`尾号xxxx卡10月24日00:59${body}，余额xxxx.86元。【工商银行】`, new Date(2026, 9, 24, 1));
    expect(result.draft).toBeNull();
  });
  it.each([")。", "，余额100元("])("rejects unbalanced parentheses after the merchant: %s", suffix => {
    const result = parseSms(`尾号xxxx卡10月24日00:59支出(烟酒)20元${suffix}【工商银行】`, new Date(2026, 9, 24, 1));
    expect(result.draft).toBeNull();
  });
  it("keeps an ICBC group collection pending and extracts its detail instead of the balance", () => {
    const result = parseSms("尾号xxxx卡10月22日19:27支出(转账财付通-群收款)30.90元，余额8xxxx元。【工商银行】", new Date(2026, 9, 22, 20));
    expect(result.draft).toMatchObject({ amountCents: 3090, date: "2026-10-22T19:27", merchant: "财付通-群收款", source: "sms", note: "" });
    expect(result.requiresReview).toBe(true);
    expect(result.warnings.join("")).toContain("每次待确认");
  });
  it.each(["消费群收款", "支付-财付通-群收款", "支付失败", "支付撤销"])("requires review for ambiguous ICBC description: %s", detail => {
    const result = parseSms(`尾号xxxx卡10月22日19:27支出(${detail})30.90元，余额8000元。【工商银行】`, new Date(2026, 9, 22, 20));
    expect(result.draft?.amountCents).toBe(3090);
    expect(result.requiresReview).toBe(true);
  });
  it("extracts spending rather than balance and keeps missing merchant visible", () => {
    const result = parseSms(
      "【招商银行】您尾号1234的卡10月21日18:32消费人民币58.30元，余额12,345.67元。",
      reference,
    );
    expect(result.draft).toMatchObject({
      amountCents: 5830,
      kind: "expense",
      date: "2026-10-21T18:32",
      source: "sms",
      category: "待分类",
      merchant: "待补充商户",
    });
    expect(result.warnings.join("")).toContain("商户");
    expect(validateTransaction({ ...result.draft, id: "test" })).toBe(true);
  });

  it("parses merchant and a full calendar date", () => {
    const result = parseSms(
      "您于2026年10月20日12:05在美团外卖消费人民币35.80元，可用余额500元。",
      reference,
    );
    expect(result.draft).toMatchObject({
      merchant: "美团外卖",
      date: "2026-10-20T12:05",
      amountCents: 3580,
    });
  });

  it("normalizes full-width currency and figures", () => {
    expect(
      parseSms("您的卡消费￥１２３．４５元，余额５００元。", reference).draft
        ?.amountCents,
    ).toBe(12345);
  });

  it("does not mistake the word Alipay for a payment action", () => {
    expect(
      parseSms("您的支付宝收到入账人民币100元。", reference).draft?.kind,
    ).toBe("income");
  });

  it("does not mistake a repayment due date for an actual repayment", () => {
    expect(
      parseSms("您的信用卡消费人民币88元，还款日为11月10日。", reference).draft
        ?.kind,
    ).toBe("expense");
  });

  it.each([
    ["您10/21 12:30收到退款人民币20.00元，余额80元。", "refund"],
    ["您10月21日12:30信用卡还款人民币100元，余额800元。", "transfer"],
    ["您10月21日12:30向支付宝充值人民币100元，余额800元。", "transfer"],
    ["您10月21日12:30转出人民币100元，余额800元。", "transfer"],
    ["您10月21日12:30工资入账人民币5000元，余额8000元。", "income"],
  ])("keeps non-consumption operations distinct: %s", (text, kind) => {
    expect(parseSms(text, reference).draft?.kind).toBe(kind);
  });

  it("infers previous year over the January boundary", () => {
    const result = parseSms(
      "您12月31日23:58消费人民币18元。",
      new Date(2026, 0, 1, 1, 0),
    );
    expect(result.draft?.date).toBe("2025-12-31T23:58");
    expect(result.warnings.join("")).toContain("年份");
  });

  it("warns when transaction date is missing", () => {
    const result = parseSms("您在便利店消费人民币18元。", reference);
    expect(result.draft?.date).toBe("2026-10-22T09:30");
    expect(result.warnings.join("")).toContain("当前时间");
  });

  it.each([
    "",
    "您的账户余额人民币100元。",
    "验证码123456，支付金额人民币20元。",
    "您消费美元20.00，余额人民币100元。",
    "您消费人民币0元。",
    "您消费人民币20.001元。",
    "您消费人民币1,23.45元。",
    "您消费1,23.45元。",
    "您的账单本期应还款人民币5000元。",
    "您消费人民币-20元。",
    "您2026年2月30日12:30消费人民币20元。",
    "您消费人民币20元，另消费人民币30元。",
    "您消费人民币20元，另消费人民币20元。",
  ])("rejects unsafe or ambiguous message: %s", (text) => {
    const result = parseSms(text, reference);
    expect(result.draft).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("does not retain raw SMS/account details in the resulting note", () => {
    const result = parseSms(
      "您尾号1234消费人民币88元，余额3000元。",
      reference,
    );
    expect(result.draft?.note).toBe("");
  });
});

describe("CSV bill parsing", () => {
  it("imports canonical rows with quoted commas, quotes and newlines", () => {
    const text =
      '\uFEFF日期,类型,金额,商户,分类,备注,交易编号,来源\r\n2026-10-21 12:30,支出,12.34,"咖啡,小店",餐饮,"第一行\n第二行说""谢谢""",wx-01,wechat\r\n2026-10-22 13:00,退款,2.34,咖啡小店,餐饮,退回,wx-02,wechat';
    const result = parseCsv(text);
    expect(result.errors).toEqual([]);
    expect(result.drafts).toHaveLength(2);
    expect(result.drafts[0]).toMatchObject({
      merchant: "咖啡,小店",
      note: '第一行\n第二行说"谢谢"',
      amountCents: 1234,
      sourceRef: "wx-01",
      source: "wechat",
    });
    expect(result.drafts[1].kind).toBe("refund");
    result.drafts.forEach((draft, i) =>
      expect(validateTransaction({ ...draft, id: `test-${i}` })).toBe(true),
    );
  });

  it("finds WeChat headers after metadata and excludes failed payments", () => {
    const result = parseCsv(
      "微信支付账单明细\n微信昵称：测试\n----------------\n交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注\n2026-10-21 12:30:45,商户消费,面馆,牛肉面,支出,¥28.00,招商银行,支付成功,202610210001,shop001,/\n2026-10-21 13:30:45,商户消费,面馆,牛肉面,支出,¥28.00,招商银行,支付失败,202610210002,shop002,/",
    );
    expect(result.errors).toEqual([]);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({
      source: "wechat",
      kind: "expense",
      amountCents: 2800,
      merchant: "面馆",
      sourceRef: "202610210001",
    });
    expect(result.skipped).toBe(1);
  });

  it("imports Alipay header names, income and transfer separately", () => {
    const result = parseCsv(
      "支付宝交易记录明细查询\n交易号,商家订单号,交易创建时间,付款时间,类型,交易对方,商品名称,金额（元）,收/支,交易状态,成功退款（元）,备注\nali001,s001,2026/10/20 12:30:00,,即时到账,工资,工资,1000.00,收入,交易成功,0.00,\nali002,s002,2026/10/20 13:00:00,,转账,朋友,转账,50.00,支出,交易成功,0.00,",
    );
    expect(result.errors).toEqual([]);
    expect(result.drafts.map((draft) => draft.kind)).toEqual([
      "income",
      "transfer",
    ]);
    expect(result.drafts[0].source).toBe("alipay");
  });

  it("supports tab-delimited exports and missing time warnings", () => {
    const result = parseCsv(
      "日期\t类型\t金额\t商户\t分类\n2026-10-21\t支出\t20\t地铁\t交通",
    );
    expect(result.errors).toEqual([]);
    expect(result.drafts[0].date).toBe("2026-10-21T00:00");
    expect(result.warnings.join("")).toContain("00:00");
  });

  it("puts unsupported categories in review", () => {
    const result = parseCsv(
      "日期,类型,金额,商户,分类\n2026-10-21 12:00,支出,20,咖啡店,美食饮品",
    );
    expect(result.drafts[0].category).toBe("待分类");
    expect(result.warnings.join("")).toContain("分类");
  });

  it("does not turn a refund-bearing original order into a new full refund", () => {
    const result = parseCsv(
      "日期,类型,金额,商户,交易状态\n2026-10-21 12:00,支出,100,商场,已全额退款",
    );
    expect(result.drafts).toHaveLength(0);
    expect(result.errors.join("")).toContain("退款");
  });

  it("accepts a standalone refund income row", () => {
    const result = parseCsv(
      "交易时间,交易类型,交易对方,收/支,金额(元),当前状态\n2026-10-21 12:00:00,退款,商场,收入,¥20.00,退款成功",
    );
    expect(result.drafts[0].kind).toBe("refund");
  });

  it.each([
    ["日期,类型,金额,商户\n2026-02-30 12:00,支出,20,商场", "日期"],
    ["日期,类型,金额,商户\n2026-10-21 25:00,支出,20,商场", "日期"],
    ["日期,类型,金额,商户\n2026-10-21 12:00:99,支出,20,商场", "日期"],
    ["日期,类型,金额,商户\n2026-10-21 12:00,支出,-20,商场", "金额"],
    ["日期,类型,金额,商户\n2026-10-21 12:00,支出,20.001,商场", "金额"],
    ["日期,类型,金额,商户\n2026-10-21 12:00,支出,USD20,商场", "人民币"],
    ["日期,类型,金额,商户,币种\n2026-10-21 12:00,支出,20,商场,HKD", "人民币"],
    ["日期,类型,金额,商户\n2026-10-21 12:00,未知,20,商场", "类型"],
  ])(
    "reports row-specific invalid data without silently importing: %s",
    (text, errorText) => {
      const result = parseCsv(text);
      expect(result.drafts).toHaveLength(0);
      expect(result.errors.join("")).toContain(errorText);
      expect(result.errors.join("")).toContain("第 2 行");
    },
  );

  it("keeps valid rows when another row is invalid", () => {
    const result = parseCsv(
      "日期,类型,金额,商户\n2026-10-21 12:00,支出,20,商场\ninvalid,支出,30,饭店",
    );
    expect(result.drafts).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });

  it.each([
    "",
    "商户,金额\n饭店,20",
    '日期,类型,金额,商户\n2026-10-21 12:00,支出,20,"未闭合',
  ])("rejects malformed or unsupported files", (text) => {
    const result = parseCsv(text);
    expect(result.drafts).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
