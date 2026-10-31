# 设置更新与自动同步实施计划

**Goal:** 新短信在网页自动反映，设置里可主动检查和安装网页更新。

**Architecture:** 复用唯一 Service Worker 注册；应用更新状态由一个内存控制器共享给提示与设置。账本继续使用既有云端同步服务。

**Tech Stack:** React、TypeScript、Vite PWA、Vitest、Playwright。

- [ ] `src/lib/cloudStore.ts`：可见性变化时读云端，成对清理监听；用单测和短信浏览器回归验证不点按钮也更新金额。
- [ ] `src/lib/appUpdate.ts`：共享检查、发现和安装状态，串行检查，检查/下载超时及离线错误不得报告当前最新。
- [ ] `src/main.tsx`：将检查与安装接入现有唯一注册，检查等待下载中的 worker 结束。
- [ ] `src/components/AppUpdateNotice.tsx` 与新增设置卡：共用安装状态和确认文案；`src/App.tsx` 设置页接入。
- [ ] `scripts/update-smoke.cjs`：先复现缺失入口，再验证当前/离线/新版本/取消/安装与旧账本保留。
- [ ] 单测、构建、同步与更新浏览器检查通过，独立审查后发布并检查生产资源和页面。

约束：不修改用户账目和数据库；不清浏览器数据；保留用户未同步编辑和历史月份选择。
