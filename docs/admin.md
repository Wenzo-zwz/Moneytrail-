# 唯一管理员后台

管理员继续使用自己的 Moneytrail 邮箱账号登录，没有默认管理员密码。后台提供用户目录、注册和邮箱验证状态、最近登录及账本同步概览；不读取消费金额、商户、备注或完整账本，也不提供删除、禁用账号等操作。

## 绑定管理员

首次设置需要项目所有者在 Supabase SQL Editor 操作。前端公开 key 没有建表或授予管理员的权限。

1. 用准备成为管理员的邮箱在 Moneytrail 注册，并完成邮箱验证。
2. 在自己的 Supabase 项目执行 `supabase/migrations/202610220002_single_admin.sql`。
3. 打开 `supabase/admin-owner.sql`，将 `ADMIN_EMAIL_HERE` 替换为刚才已验证的邮箱，在同一项目执行。
4. 管理员正常登录后，从“我的账户 → 管理员后台”进入，也可访问 `https://wenzo-zwz.github.io/Moneytrail-/?view=admin`。

绑定脚本只接受唯一匹配、已验证且未删除或禁用的账号。数据库保存用户 UUID，后续改邮箱不会将权限转给其他账号。重复绑定同一账号是安全的；已经绑定其他账号时会报错，不会静默替换。

项目所有者可在数据库控制台撤销绑定。网页不提供自行申请、授予或转移管理员的接口。

## 权限边界

- `moneytrail_private.admin_owner` 只允许一条管理员绑定。客户端没有该 schema 或表的访问权限。
- `moneytrail_is_admin()` 从认证身份和数据库绑定核验权限，不信任浏览器中的邮箱、角色标记、URL 参数或用户可编辑的 metadata。
- `moneytrail_admin_overview()` 每次请求都重新核验管理员，非管理员或未登录请求不能获得概览数据。
- 原有账本 RLS 不扩大：即使是管理员，普通账本接口也只能读取自己的账目。
- 管理概览只存在于当前页面内存，不写入本地存储；退出或切换账号时卸载页面并取消未完成请求。

`?view=admin` 是页面入口，不是权限凭据。普通账号直接打开该地址仍会被服务端拒绝。数据库迁移或绑定未完成时默认拒绝后台访问，普通记账功能继续可用。

## 验证

```sh
npm test
npm run typecheck
MONEYTRAIL_CHROMIUM_PATH=/usr/bin/chromium npm run test:admin
```

数据库测试在实际 PostgreSQL 引擎 PGlite 中检查权限、唯一绑定、伪造角色及所有者失效等情形。浏览器测试使用真实 Supabase SDK 和拦截的服务夹具，覆盖管理员、普通账号、缺少迁移、退出切换、竞态和手机布局。

这些本地测试不能证明托管 Supabase 的身份验证或管理员绑定已经生效。执行真实项目脚本后，还需分别用管理员和普通账号验证后台访问；密码、访问令牌和管理级 key 不需要发给开发者。
