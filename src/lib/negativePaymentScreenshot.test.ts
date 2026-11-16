import { describe, expect, it } from "vitest";
import { parsePaymentScreenshot } from "./paymentScreenshot";

const payment = "支付成功\n-28.70\n支付时间：2026-11-16 12:32:04";
const captured = "14:56\n<\n全部账单\n管理极速付款\n支付时间\n付款方式\n支付奖励\n收单机构\n清算机构\n交易详情\n英國 美团点餐＞\n示例米线\n示例一碗・云南伙食\n-28.70\n交易成功\n极速付款\n2026-11-16 12:32:04\n余额宝＞\nv 立即领取15积分\n京示例支付技不有限公司\n中国银联股份有限公司\n已完成\n共1件\n更多～\n账单管理\n账单分类\n标签\n已解锁“吃顿饭“贴纸，去兑换好礼。\n餐饮美食＞\n请选择＞";

describe("amount-first screenshot recovery", () => {
  it("recovers the actual title-free phone output", () => {
    expect(parsePaymentScreenshot(captured).candidates[0]).toMatchObject({
      amountCents: 2870, merchant: "示例一碗・云南伙食", date: "2026-11-16T12:32", source: "manual",
    });
  });
  it.each(["账单详情", "全部账单", "管理极速付款", "支付奖励", "收单机构", "清算机构", "极速付款", "v 立即领取15积分", "京示例支付技不有限公司", "中国银联股份有限公司"])("does not require auxiliary text %s", line => {
    const result = parsePaymentScreenshot(captured.split("\n").filter(value => value !== line).join("\n"));
    expect(result.candidates[0]?.amountCents).toBe(2870);
  });
  it.each(["-28.70", "−28.70", "－２８．７０", "- 28.70", "￥-28.70", "-￥28.70", "-28.70元", "人民币-28.70", "-28.7"])("normalizes an explicit negative monetary value %s", amount => {
    expect(parsePaymentScreenshot(payment.replace("-28.70", amount)).candidates[0]).toMatchObject({ amountCents: 2870, merchant: "", date: "2026-11-16T12:32" });
  });
  it("accepts whole-yuan money only when currency is explicit", () => {
    expect(parsePaymentScreenshot("支付成功\n-28元").candidates[0]?.amountCents).toBe(2800);
    expect(parsePaymentScreenshot("支付成功\n-20261116").partial).toBeUndefined();
    expect(parsePaymentScreenshot("支付成功\n-20261116").candidates).toEqual([]);
  });
  it("preserves a clear amount and requires a missing merchant and time to be supplied", () => {
    const result = parsePaymentScreenshot("微信支付\n支付成功\n-28.70");
    expect(result.candidates[0]).toMatchObject({ amountCents: 2870, merchant: "", source: "wechat", category: "待分类" });
    expect(result.candidates[0].date).toBeUndefined();
  });
  it("uses an explicit merchant field without requiring a page heading", () => {
    expect(parsePaymentScreenshot(payment + "\n商户名称：示例商店").candidates[0]?.merchant).toBe("示例商店");
  });
  it.each(["-28.70", "14:56\n-28.70", "交易成功\n-28.70", "付款方式\n银行卡\n-28.70"])("keeps %s as an unclassified amount hint until the user confirms expense", text => {
    const result = parsePaymentScreenshot(text);
    expect(result.candidates).toEqual([]);
    expect(result.partial).toEqual({ amountCents: 2870, source: "manual" });
  });
  it.each([
    "账户余额\n-28.70\n支付成功", "余额：-28.70\n交易成功", "可用余额\n-28.70\n支付成功",
    "退款成功\n-28.70", "转账成功\n-28.70", "收入\n-28.70", "支付失败\n-28.70", "待支付\n-28.70",
    "美元\n-28.70", "验证码123456\n-28.70", "订单号\n-28.70\n支付成功",
    "支付成功\n-28.70\n20.00", "支付成功\n-28.70\n其他支出20.00", "支付成功\n-28.70\n另付20元",
    "支付成功\n-28.70\n-28.70", "支付成功\n-28.701", "支付成功\n-0.00", "支付成功\n-1,23.45",
  ])("does not turn unsafe or ambiguous money into an adoptable hint %#", text => {
    const result = parsePaymentScreenshot(text);
    expect(result.candidates).toEqual([]);
    expect(result.partial).toBeUndefined();
  });
  it.each(["创建时间：2026-11-16 12:32:04", "2026-11-16 12:32:04", "支付时间：2026-02-29 12:32:04", "支付时间：昨天12:32"])("keeps an unestablished payment date blank: %s", date => {
    const result = parsePaymentScreenshot("支付成功\n-28.70\n" + date);
    expect(result.candidates[0]?.amountCents).toBe(2870);
    expect(result.candidates[0]?.date).toBeUndefined();
  });
});
