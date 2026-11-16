# 截图记账共享模板审核记录 · 2026-11-16

共享链接：<https://www.icloud.com/shortcuts/aea10170903740c4b268f105169711cf>。

实际导入名称为 **MoneyTrail截图记账**，发布版本为 1。已从 iCloud 记录分别下载原始工作流和签名资产，静态检查及独立复核通过。Apple 记录返回 `signingStatus: APPROVED`；该状态不代替本地密码学验签、手机导入或权限验收。

| 资产 | 字节数 | SHA-256 |
| --- | --- | --- |
| 原始 bplist 工作流 | 2109 | `ae2088908f50e64b38b953f125f60315f03431099c995a131c261f345278fbd4` |
| 签名 AEA 资产 | 22549 | `ccf81d89801ed7004f224f996306f2697d614e42a03dfd2bf01b1125b2fb78f9` |

摘要对应本次下载，不保证同一分享链接未来的内容不变；更新版本须重新审核。仓库不保留含临时签名参数的资产下载地址。

## 核对结果

工作流恰好包含以下五个操作：

1. `is.workflow.actions.takescreenshot`：获取当前屏幕。
2. `is.workflow.actions.extracttextfromimage`：直接引用第一步截图的输出 UUID。
3. `is.workflow.actions.urlencode`：输入仅为第二步 OCR 输出，未设置解码模式或包含固定站点地址。
4. `is.workflow.actions.gettext`：内容恰为 `https://wenzo-zwz.github.io/Moneytrail-/#screenshot=` 加编码输出变量。固定前缀长 52，变量附件范围 `{52, 1}` 正确；无空格、换行或固定消费文本。
5. `is.workflow.actions.openurl`：引用第四步完整文本输出。

四条动作输出 UUID 引用均解析正确。未发现其他网络请求、短信令牌、个人消费文字、导入问题或快捷指令输入依赖。原始文件为 bplist，签名资产为 AEA；下载长度与 iCloud 元数据一致。

客户端元数据为 `5114.0.8.3`，minimum client 为 `900`，不据此承诺所有旧系统兼容。

## 交付与验收范围

共享配置登记在 `public/shortcuts/screenshot-profile.json`，生产目标固定为 `https://wenzo-zwz.github.io/Moneytrail-/#screenshot=`。只有当前站点的完整捕获地址相符时才显示该安装入口，其他部署按自己的地址手动配置。模板无需令牌；新用户在打开的网页确认或登录自己的账本。

当前用户已确认原指令能背面触发、传入 OCR，并看到正确金额的候选卡。本次完成的是共享产物静态审核；新用户从此链接导入、首次授权、绑定背面两下，以及自己的账号核对保存仍需真机验收。模板不自动确认或写入交易。

配置与使用步骤见[截图记账指南](screenshot-bookkeeping.md)。
