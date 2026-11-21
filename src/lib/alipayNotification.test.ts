import { describe, expect, it } from "vitest";
import { parseAlipayNotification } from "./alipayNotification";

const notification = (body: unknown, title: unknown = "交易提醒") => ({ title, body });
const payment = (merchant = "滴滴出行", amount = "38.40") => `你在${merchant}有一笔${amount}元的免密/自动扣款支付，点此查看详情。`;

describe("Alipay automatic-payment notification preview", () => {
  it("extracts the observed ride payment and reuses purpose details", () => {
    expect(parseAlipayNotification(notification(payment()))).toMatchObject({
      kind: "expense", source: "alipay", merchant: "滴滴出行", amountCents: 3840,
      category: "待分类", platform: "滴滴", requiresReview: true,
    });
  });

  it("retains an unknown company instead of inventing its purchase purpose", () => {
    const result = parseAlipayNotification(notification(payment("上海示例信息科技有限公司", "140.50")));
    expect(result).toMatchObject({ merchant: "上海示例信息科技有限公司", amountCents: 14050, category: "待分类", requiresReview: true });
    expect(result?.subcategory).toBeUndefined();
    expect(result?.platform).toBeUndefined();
  });

  it("uses an exact personal merchant rule without allowing automatic booking", () => {
    expect(parseAlipayNotification(notification(payment("示例科技有限公司")), [
      { merchant: "示例科技有限公司", category: "学习", subcategory: "课程培训" },
    ])).toMatchObject({ category: "学习培训", subcategory: "课程培训", classificationReason: "个人商户规则", requiresReview: true });
  });

  it("does not fabricate a transaction date, source reference or SMS evidence", () => {
    const result = parseAlipayNotification(notification(payment()));
    expect(result?.warnings).toEqual([
      "通知正文没有交易时间，请核对实际交易日期。",
      "通知正文没有订单编号，请核对是否已通过银行短信或账单记录。",
    ]);
    for (const field of ["id", "date", "receivedAt", "sourceRef", "smsEvidence", "eventId"]) {
      expect(result).not.toHaveProperty(field);
    }
  });

  it("parses both captures of identical text without treating text as an event ID", () => {
    const first = parseAlipayNotification(notification(payment()));
    const second = parseAlipayNotification(notification(payment()));
    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("allows fullwidth money, punctuation and horizontal edge spaces without changing the merchant", () => {
    expect(parseAlipayNotification(notification("　你在 ＡＢＣ商店 有一笔 １，２３４．５６ 元的免密／自动扣款支付, 点此查看详情.　", " 交易提醒 ")))
      .toMatchObject({ merchant: "ＡＢＣ商店", amountCents: 123456, requiresReview: true });
  });

  it.each(["123号便利店", "58同城", "手机充值服务中心"])("keeps legitimate merchant digits and phone-service purchases (%s)", merchant => {
    expect(parseAlipayNotification(notification(payment(merchant)))).toMatchObject({ merchant, amountCents: 3840 });
  });

  it.each([
    ["交易提醒", "昨日银行卡有支出，点此去查明细。"],
    ["芝麻粒消失提醒", "可攒14粒，逾期不收取将自动作废，请及时收取>"],
    ["每日捐步做公益时", "为患儿家庭送一份照顾"],
    ["开放值机提醒", "你的航班值机已开放，点击前往办理"],
    ["总资产收益更新提醒", "总资产理财收益已更新，立即查看"],
    ["其他提醒", payment()],
    ["交易提醒退款", payment()],
  ])("ignores irrelevant or unsupported notification %s", (title, body) => {
    expect(parseAlipayNotification(notification(body, title))).toBeNull();
  });

  it.each([
    payment().replace("支付，", "支付失败，"),
    payment().replace("支付，", "支付已取消，"),
    payment().replace("支付，", "退款，"),
    payment().replace("支付，", "转账，"),
    payment().replace("你在", "你将于明日在"),
    "优惠提醒：" + payment(),
    payment() + "消费满100元减10元",
    payment() + payment(),
    payment().replace("点此查看详情。", "点此查看详…"),
    payment().replace("点此查看详情。", ""),
    payment().replace("免密/自动扣款", "普通"),
    payment("有一笔20元的商户"),
    payment("示例商店有一笔20元"),
    payment("示例商店美元"),
    payment("USD商店"),
    payment("USD12商店"),
    payment("验证码123456"),
    payment("ＯＴＰ 123456"),
    payment("ＯＴＰ１２３４５６"),
    payment("verification123456"),
    payment("工资到账"),
    payment("收款提醒"),
    payment("优惠提醒"),
    payment("退款服务"),
    payment("转账张三"),
    payment("花呗还款"),
    payment(""),
    payment("x".repeat(201)),
  ])("rejects incomplete, ambiguous or non-purchase input %j", body => {
    expect(parseAlipayNotification(notification(body))).toBeNull();
  });

  it.each(["0", "0.00", "-1.00", "+1.00", "1.001", "1e2", "1,23.45", "12,3456.78", "NaN", "38.40美元", "10000000000.01"])("rejects invalid or out-of-range yuan amount %s", amount => {
    expect(parseAlipayNotification(notification(payment("示例商店", amount)))).toBeNull();
  });

  it.each(["\n", "\r\n", "\t", "\u0000", "\u200b", "\u2028"])("does not join hidden controls or actual line wraps %j", control => {
    expect(parseAlipayNotification(notification(payment().replace("有一笔", control + "有一笔")))).toBeNull();
    expect(parseAlipayNotification(notification(payment(), "交易提醒" + control))).toBeNull();
  });

  it.each([
    null, undefined, "交易提醒", 1, true, [], {}, { title: "交易提醒" },
    notification(null), notification(38.4), notification([]), notification({}),
    notification(payment(), null), notification(payment(), 1),
    notification(payment(), "交易提醒" + " ".repeat(101)),
    notification(payment() + " ".repeat(2001)),
  ])("ignores malformed extracted input %#", input => {
    expect(parseAlipayNotification(input)).toBeNull();
  });
});
