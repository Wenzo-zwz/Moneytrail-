import { BANK_RULES_V4_NAMES, BANK_RULES_V4_PROFILE, getReleasedBankRulesV4, isBankRulesV4ProjectCompatible, type BankRulesV4Profile } from "../lib/bankRulesV4";

export default function BankRulesV4Setup({ projectUrl, enabled, profile = BANK_RULES_V4_PROFILE }: {
  projectUrl: string; enabled: boolean; profile?: BankRulesV4Profile;
}) {
  if (!isBankRulesV4ProjectCompatible(projectUrl)) return null;
  const release = getReleasedBankRulesV4(projectUrl, profile);
  if (!release) return <p className="sms-shortcut-note">v4 私有试用已有真机验证。规则缓存和定时更新目前仍在试用。</p>;
  return <section className="three-bank-guide" aria-label="银行收支 v4 设置">
    <h5>银行收支 v4</h5>
    <p>分别安装记账指令和规则更新指令。后续兼容规则由更新指令下载；新增动作或来源保护仍可能需要更新指令本体。</p>
    <div className="three-bank-actions">
      {enabled ? <a className="button primary sms-shortcut-install" href={release.smsUrl} target="_blank" rel="noopener noreferrer">安装 v4 记账指令</a>
        : <button className="button secondary sms-shortcut-install" type="button" disabled>安装 v4 记账指令</button>}
      <a className="button secondary sms-shortcut-install" href={release.updateUrl} target="_blank" rel="noopener noreferrer">安装 v4 更新指令</a>
    </div>
    {!enabled && <p className="sms-shortcut-caution">请先启用个人接入并保存令牌，再安装记账指令；更新指令不需要个人令牌。</p>}
    <ol>
      <li><strong>准备本机文件夹</strong><p>在「文件 → 浏览 → 我的 iPhone」新建 MoneyTrail 文件夹，只需建立一次。每台新设备都需重新选择自己的目录。</p></li>
      <li><strong>让两条指令使用同一目录</strong><p>在指令编辑页，将「{BANK_RULES_V4_NAMES.update}」的读取与存储动作，以及「{BANK_RULES_V4_NAMES.sms}」的读取动作，都选为同一个本机 MoneyTrail 文件夹。文件名保留 <code>bank-rules-v4.txt</code>。</p></li>
      <li><strong>先运行规则更新</strong><p>手动运行「{BANK_RULES_V4_NAMES.update}」，允许文件访问与公开规则下载。首次写入时会显示更新通知，可以在「文件」中打开本机规则文件核对版本。遇到相同版本时会保留原文件并安静结束。</p></li>
      <li><strong>填写自己的记账令牌</strong><p>已有有效令牌可直接沿用；首次接入请先用上方按钮生成并保存。只在记账指令的导入问题中填写，更新指令不填令牌。</p></li>
      <li><strong>分别设置两类自动化</strong><p>新建「信息」自动化，选择真实银行发件人，“信息包含”留空。把「快捷指令输入」转成文本，传给「{BANK_RULES_V4_NAMES.sms}」。另建「特定时间」自动化，运行「{BANK_RULES_V4_NAMES.update}」；不要把规则下载串进短信自动化。若系统询问是否允许运行对应指令，点「允许」。</p></li>
      <li><strong>核对一次真实接收</strong><p>在手机锁屏时等待一条正常发生的新银行短信，再核对服务器接收时间、金额及“待确认／已入账”状态。历史时间或更新通知不能代替这次接收验收。</p></li>
    </ol>
    <p className="help-text">手机上的文件夹选择、授权和自动化仍需本人完成。网页显示的规则版本不能证明手机已更新；旧 v3 不会自动变成 v4。</p>
  </section>;
}
