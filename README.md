# Project Nexus

B2B Transaction Collaboration Platform — 面向企业的交易协作平台。项目包含本地演示模式，以及正在开发的服务端身份与企业协作模式。

> 默认启动真实身份模式；真实模式需要本地 API、PostgreSQL 和 OIDC 服务。只有显式使用 `npm run dev:demo` 才运行虚构数据演示。演示账号切换不是身份认证。

## 技术架构

Electron + electron-vite · React 18 + TypeScript · Tailwind CSS · Zustand · Tiptap · 本地 JSON 持久化。
详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 安装与启动

需要 Node.js 22 或更高版本。真实身份模式需安装并启动 Docker Compose。

### 本地真实身份模式

1. 安装依赖并生成仅供本机开发的随机凭据：

   ```bash
   npm install
   node scripts/dev-services.mjs setup
   ```

   脚本首次从 `.env.example` 创建被 Git 忽略的 `.env`，生成数据库、Keycloak 管理员、OIDC client secret 和 32 字节会话加密密钥，并把模板中的 Keycloak client secret 占位符替换为本地值后写入被忽略的 `.dev/` realm 导入文件。这些凭据仅供本机，不要复制到共享环境或生产环境。

2. 启动 PostgreSQL、Keycloak 与 Mailpit：

   ```bash
   node scripts/dev-services.mjs services
   ```

   服务端口仅绑定回环地址：PostgreSQL `127.0.0.1:5432`、Keycloak `127.0.0.1:8080`、Mailpit SMTP `127.0.0.1:1025`、Mailpit 网页 `http://127.0.0.1:8025`。等待 Keycloak 完成首次启动和 realm 导入。导入 realm 不包含任何 seed 用户；新用户必须自行注册并完成邮箱验证。PostgreSQL 与 Keycloak 使用本地 Docker 命名卷，容器重建后开发数据会保留；这只是本机开发持久化，不是生产数据存储、备份或高可用方案。

3. 在独立终端启动 API：

   ```bash
   node scripts/dev-services.mjs api
   ```

   API 在本机 `127.0.0.1:4318` 运行。Keycloak issuer 和 OIDC 回调使用同一外部地址，回调必须精确匹配 `http://127.0.0.1:4318/auth/callback`；不要把 API/Keycloak 地址改成容器内部主机名或其他端口。

4. 再开独立终端启动 Electron 客户端：

   ```bash
   node scripts/dev-services.mjs app
   ```

   该命令用 Node 原生 `--env-file=.env` 启动 electron-vite，确保主进程读到 `NEXUS_API_URL`。默认是身份模式；未启动 API 不会回退为演示模式。打包应用不会启用演示模式。

5. 在登录界面注册账号。开发 realm 要求验证邮箱；到 Mailpit 网页查看并打开验证邮件。忘记密码流程也会投递到 Mailpit。登录后可在「设置 → 登录与安全」打开 Keycloak 账号页配置 MFA/TOTP。

### 明确选择本地演示模式

```bash
npm run dev:demo
```

该模式仅用于本地虚构数据演示，与真实账号、数据库和 OIDC 隔离；打包应用会拒绝演示模式。

### 本地服务停止

```bash
docker compose down
```

该命令保留 PostgreSQL 命名卷。需要清除本地数据库时可显式执行 `docker compose down -v`，这会不可逆删除本地数据库卷。

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

## 已实现与开发状态

桌面端演示功能包括工作台、交易项目、合同协作、版本与建议、履约和本地 JSON 存储。身份/租户代码、API、Docker 开发配置和本地 PGlite 集成测试已进入开发分支；本地身份模式不加载演示 seed 数据。配置完成不等同于 Docker/Keycloak/OIDC 端到端验收完成。

**AI 建议中心（V0.2 进行中）**：结构化付款条款变更 → 领域事件 → 法务/财务/经营三个视角分析（财务为纯计算）→ 汇总成一条待确认建议。
建议列出其依据的每条企业记忆（事实/推断/建议分开标注），可逐条确认为事实，采纳后写入合同修改建议与活动记录；
合同被改动后旧建议自动失效；重复分析不会产生重复建议。

## 开发边界与已知限制

- 本地真实身份模式依赖本机 Docker/Keycloak/PostgreSQL 配置；本仓库开发配置不是生产部署方案。OIDC 外部登录流程、SMTP 交付和 MFA 必须按下方验收清单由开发者实机验证，不能仅凭单元测试认定通过。
- Electron 主进程令牌仅保存在内存，重启应用后需要重新登录；不要在 renderer、localStorage 或 JSON 文件中持久化令牌。
- 企业邀请目前为站内邀请，不会发送邮件；邮箱验证和密码重置邮件由 Keycloak 发到本地 Mailpit。
- 服务端业务状态当前为 PostgreSQL `business_state` 单行 JSONB 全局快照，所有组织共享同一个串行化快照，不是按企业拆分的交易级关系表；仅用于开发验证，尚不满足生产扩展、备份恢复与隔离运维要求。
- `npm test` 中的 PGlite 测试在进程内运行 PostgreSQL WASM，验证 schema/SQL/权限路径，不验证多连接锁竞争、持久化、Docker、Keycloak 网络登录或真实邮箱交付。
- 6B-D 及真实双设备验收尚未完成；不得将本地开发模式描述为已通过端到端安全验收。
- 本地演示账号切换不是认证，演示 JSON 数据在本机磁盘保存。
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
   企业成员也可在交易详情或建议中心点「让 AI 团队分析」手动触发一次协同分析。综合建议含内部财务信息，仅所属企业成员可读取、生成和处理，外部律师仅参与其授权范围内的合同协作。

预置的「智能设备采购项目」只在显式启动的本地演示模式中提供；真实身份模式从空企业状态开始。

## 真实身份模式验收清单

在 Docker、API 和 Electron 均已启动后，至少人工验证：

- 注册新邮箱，Mailpit 收到验证邮件；未验证邮箱不能成功建立登录会话。
- 使用验证链接完成邮箱验证，然后登录并创建两个企业，切换企业后数据范围随当前企业变化。
- 在 Keycloak 账号页启用 TOTP/MFA，再使用 MFA 登录；测试忘记密码邮件和密码重置。
- 在两台设备/独立客户端分别登录两个账号，创建成员邀请、用被邀请的验证邮箱领取，并确认非成员不能跨企业读写。
- 移除成员或降权后，在其原客户端下一次读写立即反映新权限；登出与撤销其他会话也需人工验证。
- 重启 Electron 后确认令牌未被持久化，用户需要重新认证。

这份清单尚未由本地 Docker/IdP 环境端到端执行。
