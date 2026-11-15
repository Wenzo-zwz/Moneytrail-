import { describe, expect, it } from "vitest";
import { parseAlipayScreenshot } from "./alipayScreenshot";

const payment = (merchant = "滴滴出行", amount = "38.40") => `你在${merchant}有一笔${amount}元的免密/自动扣款支付，点此查看详情。`;
const details = (extra: string[] = []) => ["支付宝", "付款详情", "支付成功", "商户：滴滴出行", "实付：￥38.40", ...extra].join("\n");

describe("Alipay screenshot OCR review candidates", () => {
  it("extracts both observed notifications without recording the screen clock or relative day", () => {
    const result = parseAlipayScreenshot([
      "22:21", "支付宝", "即时通知 16:54", "前序航班到达通知", "请留意机场稍后的登机通知",
      "芝麻粒消失提醒", "可攒14粒，逾期不收取将自动作废，请及时收取>",
      "即时通知 昨天23:25", "交易提醒", "你在滴滴出行有一笔38.40元的免密/自动扣款", "支付，点此查看详情。",
      "芝麻粒消失提醒", "可攒15粒，逾期不收取将自动作废，请及时收取>",
      "银行卡支出提醒", "昨日银行卡有支出，点此去查明细。", "交易提醒 昨天12:01",
      "你在上海示例信息科技有限公司有一笔", "140.50元的免密/自动扣款支付，点此查看详情。",
      "总资产收益更新提醒", "总资产理财收益已更新，立即查看",
    ].join("\n"));
    expect(result.error).toBeUndefined();
    expect(result.candidates).toEqual([
      { key: "alipay-screenshot-0", merchant: "滴滴出行", amountCents: 3840, category: "交通", subcategory: "打车", platform: "滴滴" },
      { key: "alipay-screenshot-1", merchant: "上海示例信息科技有限公司", amountCents: 14050, category: "待分类" },
    ]);
    expect(result.warnings.join(" ")).toContain("顶部时钟");
    expect(result.warnings.join(" ")).toContain("重复");
  });

  it("preserves two real same-merchant same-price captures rather than suppressing repeated text", () => {
    const result = parseAlipayScreenshot(["支付宝", "交易提醒", payment(), "交易提醒", payment()].join("\n"));
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map(value => value.key)).toEqual(["alipay-screenshot-0", "alipay-screenshot-1"]);
    expect(result.candidates.map(value => value.amountCents)).toEqual([3840, 3840]);
    expect(parseAlipayScreenshot(["支付宝", "交易提醒", payment(), "交易提醒", payment()].join("\n"))).toEqual(result);
    for (const value of result.candidates) {
      for (const field of ["id", "date", "sourceRef", "orderId", "eventId", "source", "smsEvidence"]) expect(value).not.toHaveProperty(field);
    }
  });

  it("supports bounded OCR wrapping, fullwidth money and punctuation without changing a merchant name", () => {
    const result = parseAlipayScreenshot("交易提醒\r\n你在ＡＢＣ商店有一笔１，２３４．\r\n５６元的免密／自动扣款支付,\r\n点此查看详情.");
    expect(result.candidates).toEqual([{ key: "alipay-screenshot-0", merchant: "ＡＢＣ商店", amountCents: 123456, category: "待分类" }]);
  });

  it("never borrows an amount from the following complete notification", () => {
    const result = parseAlipayScreenshot(["交易提醒", "你在第一家商店有一笔", "交易提醒", payment("第二家商店", "12.00")].join("\n"));
    expect(result.candidates).toEqual([{ key: "alipay-screenshot-0", merchant: "第二家商店", amountCents: 1200, category: "待分类" }]);
    expect(result.warnings.join(" ")).toContain("不完整");
  });

  it.each([
    "你在商店\n交易提醒\n有一笔38.40元的免密/自动扣款支付，点此查看详情。",
    "你在商店\n即时通知 12:30\n有一笔38.40元的免密/自动扣款支付，点此查看详情。",
    "你在滴滴\n其他通知\n有一笔38.40元的免密/自动扣款支付，点此查看详情。",
    "你在滴滴\n另一项提醒 12:30\n有一笔38.40元的免密/自动扣款支付，点此查看详情。",
    "你在滴滴\n支付宝\n有一笔38.40元的免密/自动扣款支付，点此查看详情。",
    "你在商店\n昨天23:25\n有一笔38.40元的免密/自动扣款支付，点此查看详情。",
    payment() + "支付失败",
    payment() + "\n支付失败，款项未扣除",
    payment().replace("点此查看详情。", "点此查看详…"),
    payment().replace("支付，", "退款，"),
    payment("余额20元商店"),
    payment("USD商店"),
    payment("韩元商店"),
    payment("转账张三"),
  ])("does not turn truncated or ambiguous notification text into a purchase %j", text => {
    expect(parseAlipayScreenshot(text).candidates).toEqual([]);
  });

  it("does not pretend the OCR text authenticates the source App", () => {
    const result = parseAlipayScreenshot(payment());
    expect(result.candidates).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("无法验证通知来源");
  });

  it("reuses a personal merchant classification while keeping a preview key local", () => {
    expect(parseAlipayScreenshot(payment("示例科技有限公司"), [{ merchant: "示例科技有限公司", category: "学习", subcategory: "课程培训" }]).candidates[0])
      .toMatchObject({ merchant: "示例科技有限公司", category: "学习", subcategory: "课程培训", key: "alipay-screenshot-0" });
  });

  it("reads a single explicit CNY payment detail and a complete labelled transaction timestamp", () => {
    const result = parseAlipayScreenshot(details(["交易时间：2026年11月15日 12:01:59", "订单号：202611151234567890"]));
    expect(result.error).toBeUndefined();
    expect(result.candidates).toEqual([{
      key: "alipay-screenshot-0", merchant: "滴滴出行", amountCents: 3840, date: "2026-11-15T12:01", category: "交通", subcategory: "打车", platform: "滴滴",
    }]);
    expect(result.candidates[0]).not.toHaveProperty("sourceRef");
  });

  it("supports separate label/value lines, an explicit expense direction and currency label", () => {
    const result = parseAlipayScreenshot(["支付宝账单详情", "交易类型", "支出", "收款方", "上海示例信息科技有限公司", "金额", "-140.50", "币种", "人民币", "付款时间", "2026/11/15 09:01"].join("\n"));
    expect(result.candidates).toEqual([{
      key: "alipay-screenshot-0", merchant: "上海示例信息科技有限公司", amountCents: 14050, category: "待分类", date: "2026-11-15T09:01",
    }]);
  });

  it.each(["实付金额", "支出金额", "付款金额", "金额"])("recognizes only an explicit amount label %s", label => {
    const text = details().replace("实付：￥38.40", `${label}：38.40元`);
    expect(parseAlipayScreenshot(text).candidates[0]?.amountCents).toBe(3840);
  });

  it.each([
    "交易时间：昨天 23:25", "交易时间：11月15日 12:01", "交易时间：2026-11-15", "交易时间：12:01",
    "交易时间：2026-02-29 12:01", "交易时间：2026-11-31 12:01", "交易时间：2026-11-15 24:01", "交易时间：2026-11-15 12:60", "交易时间：2026-11-15 12:01:60",
    "创建时间：2026-11-15 12:01", "通知时间：2026-11-15 12:01", "22:21\n昨天23:25",
    "交易时间：2026-11-15 12:01\n付款时间：2026-11-15 12:02",
  ])("leaves an incomplete, invalid, unrelated or conflicting date unassigned: %s", extra => {
    const result = parseAlipayScreenshot(details([extra]));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].date).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("不会使用截图时钟或当前时间");
  });

  it("keeps an explicit leap-day timestamp without depending on the machine's current day", () => {
    expect(parseAlipayScreenshot(details(["支付时间：2024-02-29T00:00"])).candidates[0].date).toBe("2024-02-29T00:00");
  });

  it.each([
    details().replace("支付宝", "微信支付"),
    details().replace("支付宝", "工商银行"),
    details().replace("支付宝", "支付宝科技有限公司"),
    details().replace("支付成功", "请确认付款"),
    "支付宝\n商户名称\n支付成功\n实付金额38.40元",
    details().replace("商户：滴滴出行", "商户：支付成功"),
    "支付宝\n收支 支出\n商户名称 A\n实付金额38.40元\n处理中",
    "支付宝\n收支 支出\n商户名称 A\n实付金额38.40元\n交易进行中",
    details().replace("商户：滴滴出行", "商品说明：滴滴出行"),
    details().replace("商户：滴滴出行", ""),
    details().replace("实付：￥38.40", ""),
    details().replace("实付：￥38.40", "金额：38.40"),
    details().replace("实付：￥38.40", "实付：+38.40元"),
    details().replace("实付：￥38.40", "实付：0元"),
    details().replace("实付：￥38.40", "实付：38.401元"),
    details().replace("实付：￥38.40", "实付：USD38.40"),
    details(["收款方：另一家商店"]),
    details(["金额：￥38.40"]),
    details(["订单金额：￥48.40", "优惠金额：￥10.00"]),
    details(["币种：人民币", "手续费：1.00"]),
    details(["另一笔合计20元"]),
    details(["退款成功"]),
    details(["转账到账"]),
    details(["交易关闭"]),
    details(["外币交易"]),
    details(["币种：韩元"]),
    details(["币种：未知币种"]),
    details(["币种：人民币", "币种：TWD"]),
  ])("rejects unsupported, incomplete or ambiguous payment detail %j", text => {
    const result = parseAlipayScreenshot(text);
    expect(result.candidates).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it.each([null, undefined, 42, [], {}, "", " ", "x".repeat(16001), details(["验证码123456"]), details(["ＯＴＰ１２３４５６"]), payment() + "\u0000", payment() + "\u200b"])("does not parse invalid or security-sensitive OCR input %#", text => {
    const result = parseAlipayScreenshot(text);
    expect(result.candidates).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it.each([
    "芝麻粒消失提醒\n可攒14粒，请及时收取", "银行卡支出提醒\n昨日银行卡有支出，点此去查明细。",
    "前序航班到达通知\n请留意机场稍后的登机通知", "总资产收益更新提醒\n总资产理财收益已更新，立即查看",
  ])("ignores non-purchase screens without manufacturing a candidate %j", text => {
    expect(parseAlipayScreenshot(text).candidates).toEqual([]);
  });
});
