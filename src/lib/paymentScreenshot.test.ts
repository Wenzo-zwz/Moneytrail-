import { describe, expect, it } from "vitest";
import { parsePaymentScreenshot } from "./paymentScreenshot";

const details = (heading = "微信支付", extra: string[] = []) => [heading, "支付成功", "商户全称：示例便利店", "支付金额：￥29.80", ...extra].join("\n");
const notification = "交易提醒\n你在滴滴出行有一笔38.40元的免密/自动扣款支付，点此查看详情。";

describe("universal payment screenshot review", () => {
  it("recognizes WeChat without changing it into an Alipay source", () => {
    const result = parsePaymentScreenshot(details("微信支付", ["支付时间：2026年11月16日09:10:22"]));
    expect(result.error).toBeUndefined();
    expect(result.candidates[0]).toMatchObject({ source: "wechat", kind: "expense", merchant: "示例便利店", amountCents: 2980, category: "购物", date: "2026-11-16T09:10" });
  });
  it("keeps the existing Alipay adapter", () => {
    expect(parsePaymentScreenshot("支付宝\n" + notification).candidates[0]).toMatchObject({ source: "alipay", kind: "expense", amountCents: 3840, merchant: "滴滴出行" });
    expect(parsePaymentScreenshot(details("支付宝").replaceAll("商户全称", "商户名称").replaceAll("支付金额", "实付金额")).candidates[0].source).toBe("alipay");
  });
  it("leaves an otherwise clear unbranded payment as an unknown/manual source", () => {
    const result = parsePaymentScreenshot(details("付款详情"));
    expect(result.candidates[0]).toMatchObject({ source: "manual", kind: "expense", amountCents: 2980 });
    expect(result.warnings.join(" ")).toContain("未确认支付平台");
  });
  it("does not invent an Alipay source from its recognizable notification format alone", () => {
    expect(parsePaymentScreenshot(notification).candidates[0].source).toBe("manual");
  });
  it.each(["商户全称", "收款方全称", "商户名称", "商户名", "收款方", "商户", "商家"])("reads explicit merchant field %s", label => {
    expect(parsePaymentScreenshot(details().replace("商户全称", label)).candidates[0]?.merchant).toBe("示例便利店");
  });
  it.each(["支付金额", "实付金额", "支出金额", "付款金额", "交易金额", "实付", "金额"])("reads explicit payment field %s", label => {
    expect(parsePaymentScreenshot(details().replace("支付金额", label)).candidates[0]?.amountCents).toBe(2980);
  });
  it("supports separate field/value lines with CNY and a negative expense display", () => {
    const text = ["微信支付", "账单详情", "收支类型", "支出", "收款方全称", "示例商店", "金额", "-29.80", "币种", "人民币"].join("\n");
    expect(parsePaymentScreenshot(text).candidates[0]).toMatchObject({ source: "wechat", amountCents: 2980 });
  });
  it("accepts a neutral completed transaction only with an explicit outgoing type", () => {
    expect(parsePaymentScreenshot(details("微信支付", ["交易类型：商户消费"]).replace("支付成功", "交易成功")).candidates[0]?.kind).toBe("expense");
    expect(parsePaymentScreenshot(details().replace("支付成功", "交易成功")).candidates).toEqual([]);
  });
  it("keeps fullwidth merchant names while accepting fullwidth money", () => {
    expect(parsePaymentScreenshot(details().replace("示例便利店", "ＡＢＣ商店").replace("￥29.80", "￥２９．８０")).candidates[0])
      .toMatchObject({ merchant: "ＡＢＣ商店", amountCents: 2980 });
  });
  it.each(["交易时间：昨天 09:10", "交易时间：11月16日 09:10", "交易时间：2026-11-16", "23:57", "创建时间：2026-11-16 09:10", "交易时间：2026-02-29 09:10", "交易时间：2026-11-16 24:10", "支付时间：2026-11-16 09:10:60", "交易时间：2026-11-16 09:10\n支付时间：2026-11-16 09:11"])("does not fabricate a date from %s", date => {
    const result = parsePaymentScreenshot(details("微信支付", [date]));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].date).toBeUndefined();
  });
  it("preserves repeated real same-price notification candidates", () => {
    const result = parsePaymentScreenshot("支付宝\n" + notification + "\n" + notification);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map(value => value.amountCents)).toEqual([3840, 3840]);
    expect(result.candidates[0].key).not.toBe(result.candidates[1].key);
  });
  it.each(["商户名称", "商户名", "付款方式", "支付方式", "支付渠道", "付款渠道", "交易渠道"])("does not treat a platform-named %s value as page branding", label => {
    let text = details("付款详情");
    if (["商户名称", "商户名"].includes(label)) text = text.replace("商户全称：示例便利店", label + "\n支付宝");
    else text = text.replace("支付成功", "支付成功\n" + label + "\n支付宝");
    const result = parsePaymentScreenshot(text);
    if (["商户名称", "商户名"].includes(label)) expect(result.candidates).toEqual([]); // A channel alone is not a concrete merchant.
    else expect(result.candidates[0]?.source).toBe("manual");
  });
  it.each(["付款方式 ：", "支付方式\t:", "支付渠道  ： "])("keeps a platform-valued spaced field out of page branding: %s", label => {
    const text = details("付款详情").replace("支付成功", `支付成功\n${label}\n支付宝`);
    expect(parsePaymentScreenshot(text).candidates[0]?.source).toBe("manual");
  });
  it.each([
    details("微信支付", ["支付宝"]),
    details().replace("支付成功", "收款成功"),
    details().replace("支付成功", "退款成功"),
    details().replace("支付成功", "转账成功"),
    details().replace("支付成功", "交易关闭"),
    details("微信支付", ["收支类型：收入"]),
    details("微信支付", ["处理中", "收支：支出"]),
    details("微信支付", ["币种：韩元"]),
    details("微信支付", ["币种：未知币种"]),
    details("微信支付", ["币种：人民币", "币种：TWD"]),
    details().replace("￥29.80", "+29.80元"),
    details().replace("￥29.80", "29.80美元"),
    details().replace("￥29.80", "0元"),
    details().replace("￥29.80", "29.801元"),
    details().replace("￥29.80", "1,23.45元"),
    details().replace("￥29.80", "29.80"),
    details("微信支付", ["订单金额：39.80元", "优惠金额：10.00元"]),
    details("微信支付", ["余额：200.00"]),
    details("微信支付", ["额外金额20元"]),
    details("微信支付", ["20.00"]),
    details("微信支付", ["−20.00"]),
    details("微信支付", ["+20.00"]),
    details("微信支付", ["—20.00"]),
    details().replace("￥29.80", "￥−29.80") + "\n另一项20元",
    details("微信支付", ["收款方：另一商店"]),
    details().replace("商户全称：示例便利店", "商户全称\n支付成功"),
    details().replace("商户全称：示例便利店", "商户全称\n订单号：123456"),
    details().replace("商户全称：示例便利店", "商户编号：123456"),
    details().replace("商户全称：示例便利店", "商户号：123456"),
    details().replace("商户全称：示例便利店", "商户类型：公司"),
    details("支付宝").replace("商户全称：示例便利店", "商户编号：123456"),
    details().replace("商户全称：示例便利店", "商户全称：29.80元"),
    details().replace("商户全称：示例便利店", "商品说明：示例商品"),
    details("微信支付", ["验证码123456"]),
    "银行卡支出提醒\n昨日银行卡有支出",
    "支付成功\n100元",
    "微信支付\n" + notification,
  ])("refuses ambiguous, incomplete or non-expense captures %#", text => {
    const result = parsePaymentScreenshot(text);
    expect(result.candidates).toEqual([]);
    expect(result.error).toBeTruthy();
  });
  it.each([undefined, null, 1, {}, [], "", "x".repeat(16001), details() + "\u0000", details() + "\u200b"])("rejects malformed OCR input %#", text => {
    expect(parsePaymentScreenshot(text).candidates).toEqual([]);
  });
  it("does not create order IDs or SMS evidence", () => {
    const result = parsePaymentScreenshot(details("微信支付", ["交易单号：123456789"]));
    for (const key of ["id", "sourceRef", "smsEvidence", "orderId", "receivedAt"]) expect(result.candidates[0]).not.toHaveProperty(key);
  });
});
