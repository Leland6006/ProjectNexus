# Project Nexus

B2B Transaction Collaboration Platform — 面向中国企业的交易协作平台。当前为 **V0.1 本地桌面端 MVP**（macOS，Electron）。

> 所有企业、人员与合同内容均为**虚构演示数据**。账号切换与权限隔离仅用于本地演示，**不是**真实的身份认证。

## 技术架构

Electron + electron-vite · React 18 + TypeScript · Tailwind CSS · Zustand · Tiptap · 本地 JSON 持久化。
详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 安装与启动

需要 Node.js 22 或更高版本。

```bash
npm install
npm run dev
```

## 测试与构建

```bash
npm test            # 单元测试（权限、业务流程、版本比较、存储迁移、HTML 清理、编辑器规则）
npm run typecheck   # TypeScript 类型检查
npm run build       # 类型检查 + 生产构建
npm run dist        # 打包 macOS DMG
```

推送到 `main` 或发起 PR 时，GitHub Actions（`.github/workflows/ci.yml`）会自动执行 typecheck、测试与构建。

## 打包与签名

`npm run dist` 默认生成**未签名**的 DMG。未签名的应用在其他 Mac 上首次打开会被 Gatekeeper 提示，需要在“系统设置 → 隐私与安全性”中手动允许。

正式分发需要 Apple Developer 账号。在 `electron-builder.yml` 中启用 `identity` 与 `notarize`，并在打包前导出：

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # 在 appleid.apple.com 生成的应用专用密码
export APPLE_TEAM_ID="TEAMID"
```

然后把 `mac.identity` 改成你的 `Developer ID Application: …` 证书名称。CI 中建议把这些值放进仓库 Secrets，不要写进配置文件。

## 目录

```
src/shared/    业务逻辑、权限、版本比较、存储迁移、HTML 清理、编辑器规则、模板、演示数据（纯 TypeScript，可独立测试）
src/main/      Electron 主进程、IPC、本地存储
src/preload/   安全桥接
src/renderer/  React 界面
tests/         单元测试
```

## 当前已实现

工作台 · 交易项目（创建/编辑/搜索/筛选/详情）· 合同中心 · 三栏合同编辑器 · 版本快照与差异比较与恢复 · 条款评论与回复 ·
修改建议（接受/拒绝）· 双方确认最终版 · 模拟账号切换与可见范围隔离 · 邀请对方与外部律师 · 项目消息 · 履约节点与付款进度 ·
AI 助手入口（模拟）· 重启后数据保留。

**AI 建议中心（V0.2 进行中）**：结构化付款条款变更 → 领域事件 → 法务/财务/经营三个视角分析（财务为纯计算）→ 汇总成一条待确认建议。
建议列出其依据的每条企业记忆（事实/推断/建议分开标注），可逐条确认为事实，采纳后写入合同修改建议与活动记录；
合同被改动后旧建议自动失效；重复分析不会产生重复建议。

## 已知限制

- 仅本地单机；账号切换不是真实认证；数据文件为明文 JSON（本地磁盘，未加密）。
- 不支持 DOCX 导入导出（仅富文本编辑）；无电子签章、无实时多人编辑。
- “AI 助手”是本地规则生成的**模拟AI输出**，未接入任何模型，不构成法律意见。
- 未接入模型时，协同分析只有**财务侧是真实计算**（现金流与资金缺口为确定性结果），法务与经营视角会显示“未接入模型，跳过”；
  接入 `LlmClient`（`setLlmClient`）后这两个节点才会产出内容。
- 合同编辑器为按条款编辑的富文本，不是 Word 级别的修订追踪。
- 打包产物未签名、未公证。

## 演示流程

1. 以 **陈思远（启明智能 商务）** 登录 → 交易项目 → 创建交易 → 邀请对方 → 创建合同（选模板）→ 共享给对方 → 保存新版本。
2. 左下角切换为 **王志诚（远航精密 商务）** → 接受邀请 → 打开合同 → 对条款提出修改建议、发表评论。
3. 切换回陈思远 → 回复评论、接受/拒绝建议 → 保存新版本 → 版本历史中比较差异。
4. 用法务账号 **林静怡** 邀请外部律师 **周明哲** → 切换为周明哲添加律师意见 → 切回远航账号确认看不到该意见。
5. 双方分别点击“确认最终版”→ 合同锁定 → 履约管理中创建节点。
6. **AI 建议中心**：打开左侧「AI 建议」→ 预置了「智能设备采购项目」的一条待确认建议（预付款 50%→10%，资金缺口 ¥342,000）→
   查看依据（已确认事实 / 推断 / 建议三类分别标注）→ 逐条「确认」把推断升级为事实 → 「采纳」或「忽略」。
   也可在交易详情或建议中心点「让 AI 团队分析」手动触发一次协同分析。

预置的「智能设备采购项目」已包含 3 个历史版本、双方意见、内部法务意见、律师意见和履约节点，可直接体验。
