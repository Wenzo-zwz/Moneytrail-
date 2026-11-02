import profile from "../../public/shortcuts/three-bank-profile.json";
import { SMS_SHORTCUT_TEMPLATE } from "./shortcutTemplate";

export const THREE_BANK_TEMPLATE = profile;
export const THREE_BANK_SIGN_COMMAND = 'shortcuts sign --mode anyone --input "$HOME/Downloads/moneytrail-three-bank-v1.unsigned.plist" --output "$HOME/Downloads/MoneyTrail 农中建通用记账.shortcut"';
export const THREE_BANK_IPHONE_STEPS = [
  `1. 在 iPhone 安装或复制原工行基础模板：${SMS_SHORTCUT_TEMPLATE.url}。将副本重命名为「${profile.name}」，保留原指令。`,
  '2. 在「将变量 短信正文 设为 文本」之后、第一个「如果」之前，加「匹配文本」。文本选择「短信正文」，关闭区分大小写，将下面的匹配规则完整粘贴。',
  profile.matchPattern,
  '3. 将第一个「如果」改为「匹配文本 有任何值」，移除旧的「工商银行、支出」及其他旧条件；里面的网络请求、通知、否则、结束如果保持原结构。',
  '4. 最上面的接入令牌文本留空，导入问题的默认答案也留空。分享这一份空白副本，个人令牌在各人安装时填写。',
  '5. 点击分享，复制新的 iCloud 链接。用另一份个人副本填自己的令牌，核对真实短信触发与待确认状态。',
].join('\n\n');
