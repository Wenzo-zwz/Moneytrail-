import { describe, expect, it } from "vitest";
import { parsePaymentScreenshot } from "./paymentScreenshot";

const details = (heading = "微信支付", extra: string[] = []) => [heading, "支付成功", "商户全称：示例便利店", "支付金额：￥29.80", ...extra].join("\n");
const notification = "交易提醒\n你在滴滴出行有一笔38.40元的免密/自动扣款支付，点此查看详情。";
// Structural transcription of a real domestic-wallet bill; merchant and item
// names are synthetic. Reward points and item counts are not extra money.
const walletBill = ["13:55", "5G", "75", "账单详情", "全部账单", "示例云南小吃店", "-28.70", "交易成功",
  "管理极速付款", "极速付款", "支付时间", "2026-11-16 12:32:04", "付款方式", "余额宝 >", "支付奖励", "立即领取15积分",
  "收单机构", "北京示例支付技术有限公司", "清算机构", "中国银联股份有限公司", "交易详情", "美团点餐", "已完成",
  "示例米线", "共1件", "更多", "账单管理", "账单分类", "餐饮美食", "标签", "请选择"].join("\n");
// Actual iPhone OCR ordering: left-column labels first, then the merchant
// summary and right-column values. Merchant and product names are synthetic;
// status-bar noise and OCR substitutions retain the observed structure.
const columnBill = ["14:141", "账单详情", ":!!! 4G 72", "全部账单", "管理极速付款", "支付时间", "付款方式", "支付奖励",
  "收单机构", "清算机构", "交易详情", "英國 美团点餐＞", "示例米线", "示例一碗・云南伙食", "-28.70", "交易成功",
  "极速付款", "2026-11-16 12:32:04", "余额宝＞", "v 立即领取15积分", "京示例支付技不有限公司", "中国银联股份有限公司",
  "已完成", "共1件", "更多～", "账单管理", "账单分类", "标签", "已解锁“吃顿饭“贴纸，去兑换好礼。", "餐饮美食＞", "请选择＞"].join("\n");

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

describe("observed domestic-wallet bill summary", () => {
  it("reads the unlabeled adjacent merchant, negative expense and full payment time for review", () => {
    const result = parsePaymentScreenshot(walletBill);
    expect(result.error).toBeUndefined();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ source: "manual", kind: "expense", merchant: "示例云南小吃店", amountCents: 2870, date: "2026-11-16T12:32" });
    expect(result.warnings.join(" ")).toContain("未确认支付平台");
    expect(result.warnings.join(" ")).toContain("截图未显示币种");
    for (const key of ["id", "sourceRef", "smsEvidence", "orderId", "receivedAt"]) expect(result.candidates[0]).not.toHaveProperty(key);
  });
  it("supports inline fields, a combined navigation heading and an explicit CNY field", () => {
    const text = walletBill.replace("账单详情\n全部账单", "账单详情 全部账单")
      .replace("付款方式\n余额宝 >", "付款方式：支付宝余额")
      .replace("支付时间\n2026-11-16 12:32:04", "支付时间：2026–11–16 12:32:04")
      .replace("收单机构\n", "收单机构：").replace("清算机构\n", "清算机构：") + "\n币种：人民币";
    const result = parsePaymentScreenshot(text);
    expect(result.candidates[0]).toMatchObject({ source: "manual", amountCents: 2870, date: "2026-11-16T12:32" });
    expect(result.warnings.join(" ")).not.toContain("截图未显示币种");
  });
  it("keeps the exact merchant text and uses existing personal classification rules", () => {
    const result = parsePaymentScreenshot(walletBill.replace("示例云南小吃店", "ＡＢＣ·示例小吃店").replace("-28.70", "−２８．７０"),
      [{ merchant: "ＡＢＣ·示例小吃店", category: "本地生活", subcategory: "餐饮" }]);
    expect(result.candidates[0]).toMatchObject({ merchant: "ＡＢＣ·示例小吃店", amountCents: 2870, category: "本地生活", subcategory: "餐饮" });
  });
  it("only suggests Alipay with explicit page branding, never from a wallet method alone", () => {
    expect(parsePaymentScreenshot(walletBill).candidates[0]?.source).toBe("manual");
    expect(parsePaymentScreenshot("支付宝\n" + walletBill).candidates[0]?.source).toBe("alipay");
  });
  it.each([
    walletBill.replace("账单详情\n", ""),
    walletBill.replace("全部账单\n", ""),
    walletBill.replace("余额宝 >", "银行卡 >"),
    walletBill.replace("付款方式\n余额宝 >", "支付方式\n银行卡 >"),
    walletBill.replace("收单机构\n北京示例支付技术有限公司\n", ""),
    walletBill.replace("清算机构\n中国银联股份有限公司\n", ""),
    walletBill.replace("中国银联股份有限公司", "其他清算机构"),
    walletBill + "\n账单详情",
    walletBill + "\n交易成功",
    walletBill + "\n付款方式：支付宝余额",
    walletBill + "\n清算机构：中国银联股份有限公司",
  ])("retains the payment when optional navigation or settlement text changes %#", text => {
    expect(parsePaymentScreenshot(text).candidates[0]).toMatchObject({ amountCents: 2870, date: "2026-11-16T12:32" });
  });
  it.each([
    walletBill.replace("示例云南小吃店\n", ""),
    ...["交易详情", "全部账单", "账单管理", "极速付款", "管理极速付款", "标签", "请选择", "123456",
      "商户名称第一行\n商户名称第二行", "第一家商店\n第二家商店"].map(value => walletBill.replace("示例云南小吃店", value)),
    walletBill + "\n收款方：另一商店",
    walletBill + "\n商户名称：另一商店",
  ])("keeps a reliable amount while leaving an uncertain merchant blank %#", text => {
    expect(parsePaymentScreenshot(text).candidates[0]).toMatchObject({ amountCents: 2870, merchant: "" });
  });
  it.each([
    walletBill.replace("支付时间\n2026-11-16 12:32:04\n", ""),
    ...["2026-02-29 12:32:04", "2026-11-16 12:32:60", "11月16日 12:32"].map(value => walletBill.replace("2026-11-16 12:32:04", value)),
    walletBill + "\n支付时间：2026-11-16 12:33:04",
  ])("preserves the amount with an empty date when payment time cannot be established %#", text => {
    const candidate = parsePaymentScreenshot(text).candidates[0];
    expect(candidate?.amountCents).toBe(2870);
    expect(candidate?.date).toBeUndefined();
  });
  it.each([
    walletBill.replace("示例云南小吃店", "商户编号：123456"),
    walletBill.replace("北京示例支付技术有限公司", "待确认"),
    ...["28.70", "+28.70", "-0.00", "-28.701", "-1,23.45"].map(value => walletBill.replace("-28.70", value)),
    ...["支付中", "收款成功", "退款成功", "转账成功"].map(value => walletBill.replace("交易成功", value)),
    ...["收支类型：收入", "交易类型：未知", "退款说明", "金额：28.70元", "订单金额：30.00元", "余额：100.00",
      "另一项20元", "其他支出 20.00", "其他支出+20.00", "其他支出−20.00", "其他支出—20.00", "+20.00", "−20.00", "—20.00",
      "币种：未知币种", "币种：USD", "验证码123456"].map(value => walletBill + "\n" + value),
    "微信支付\n" + walletBill,
    "支付宝\n微信支付\n" + walletBill,
  ])("rejects a non-purchase, malformed or ambiguous amount without offering an adoptable hint %#", text => {
    const result = parsePaymentScreenshot(text);
    expect(result.candidates).toEqual([]);
    expect(result.partial).toBeUndefined();
    expect(result.error).toBeTruthy();
  });
});

describe("iPhone column-ordered wallet bill OCR", () => {
  it("restores the observed label/value columns without using status-bar digits or reward points", () => {
    const result = parsePaymentScreenshot(columnBill);
    expect(result.error).toBeUndefined();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ source: "manual", kind: "expense", merchant: "示例一碗・云南伙食", amountCents: 2870, date: "2026-11-16T12:32" });
    expect(result.warnings.join(" ")).toContain("未确认支付平台");
    expect(result.warnings.join(" ")).toContain("截图未显示币种");
  });
  it("accepts a column-ordered bill without an embedded Meituan product block", () => {
    const result = parsePaymentScreenshot(columnBill.replace("英國 美团点餐＞\n示例米线\n", ""));
    expect(result.candidates[0]).toMatchObject({ merchant: "示例一碗・云南伙食", amountCents: 2870, date: "2026-11-16T12:32" });
  });
  it("preserves original merchant characters and recognizes normalized wallet arrows and minus signs", () => {
    const result = parsePaymentScreenshot(columnBill.replace("示例一碗・云南伙食", "ＡＢＣ・示例云南伙食").replace("-28.70", "−２８．７０"));
    expect(result.candidates[0]).toMatchObject({ merchant: "ＡＢＣ・示例云南伙食", amountCents: 2870 });
  });
  it.each([
    columnBill.replace("账单详情\n", ""),
    columnBill.replace("支付时间\n付款方式\n支付奖励\n收单机构\n清算机构\n交易详情\n", "")
      .replace("交易成功\n", "交易成功\n支付时间\n付款方式\n支付奖励\n收单机构\n清算机构\n交易详情\n"),
    columnBill.replace("余额宝＞", "银行卡＞") + "\n余额宝＞",
    columnBill.replace("京示例支付技不有限公司\n", ""),
    columnBill.replace("中国银联股份有限公司", "其他清算机构"),
    columnBill.replace("支付时间\n付款方式", "付款方式\n支付时间"),
    columnBill.replace("收单机构\n", ""),
    columnBill + "\n付款方式：支付宝余额",
    columnBill + "\n收单机构：北京另一支付有限公司",
    columnBill.replace("交易详情\n", ""),
    columnBill + "\n交易成功",
    columnBill + "\n交易类型\n支出",
  ])("recovers the amount across omitted headings and rearranged ancillary fields %#", text => {
    expect(parsePaymentScreenshot(text).candidates[0]?.amountCents).toBe(2870);
  });
  it.each([
    columnBill.replace("支付时间\n", "创建时间\n"),
    columnBill.replace("2026-11-16 12:32:04\n", "") + "\n创建时间\n2026-11-16 12:32:04",
    ...["2026-02-29 12:32:04", "2026-11-16 12:32:60", "11月16日 12:32"].map(value => columnBill.replace("2026-11-16 12:32:04", value)),
    columnBill + "\n2026-11-16 12:33:04",
    columnBill + "\n支付时间",
  ])("never fills an uncertain column date even when its amount remains usable %#", text => {
    const candidate = parsePaymentScreenshot(text).candidates[0];
    expect(candidate?.amountCents).toBe(2870);
    expect(candidate?.date).toBeUndefined();
  });
  it.each([
    columnBill.replace("示例一碗・云南伙食\n", ""),
    ...["商户第一行\n商户第二行", "账单管理", "请选择＞", "更多～", "交易详情＞", "123456"].map(value => columnBill.replace("示例一碗・云南伙食", value)),
    columnBill.replace("英國 美团点餐＞", "未知商品平台"),
  ])("does not substitute products or navigation for a missing merchant %#", text => {
    expect(parsePaymentScreenshot(text).candidates[0]).toMatchObject({ amountCents: 2870, merchant: "" });
  });
  it.each([
    columnBill.replace("示例一碗・云南伙食", "商户编号：123456"),
    ...["28.70", "+28.70", "-0.00", "-28.701"].map(value => columnBill.replace("-28.70", value)),
    ...["收款成功", "退款成功", "转账成功", "处理中"].map(value => columnBill.replace("交易成功", value)),
    ...["另一项20元", "其他支出20.00", "−20.00", "币种：USD", "验证码123456"].map(value => columnBill + "\n" + value),
    "微信支付\n" + columnBill,
    "支付宝\n微信支付\n" + columnBill,
  ])("rejects unsafe or ambiguous column amounts without a fallback hint %#", text => {
    const result = parsePaymentScreenshot(text);
    expect(result.candidates).toEqual([]);
    expect(result.partial).toBeUndefined();
    expect(result.error).toBeTruthy();
  });
});
