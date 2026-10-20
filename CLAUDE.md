# CLAUDE.md — Project Nexus 开发指引

## 项目定位

Project Nexus 是面向中国企业的 B2B 交易协作平台。**交易项目**是基础业务对象，合同只是其中的重要组成部分。
当前包括 macOS 本地桌面端 MVP 和正在开发的服务端身份/企业协作模式。服务端模式需要本地 Node API、PostgreSQL 和 OIDC Provider；仅 `npm run dev:demo` 显式进入本地虚构数据演示。开发 Docker 配置、6B-D 范围和未完成的真实双设备验收见 README/ROADMAP。不得把本地开发配置描述成生产部署或已通过 OIDC 端到端验收。

## 技术栈

Electron + electron-vite · React 18 + TypeScript · Tailwind CSS（shadcn 风格组件）· Zustand · Tiptap · Lucide 图标 ·
本地持久化为单个 JSON 文件（原子写入）· 测试使用 Node 内置 test runner · 打包使用 electron-builder。

## 常用命令

```
npm install        # 安装依赖
npm run dev        # 开发模式（Electron 窗口）
npm run format     # 统一格式
npm run format:check # 格式检查
npm run typecheck  # 类型检查
npm test           # 单元测试
npm run build      # 类型检查 + 生产构建
npm run dist       # 打包 macOS DMG（未签名）
```

## 代码结构

- `src/shared/` 纯逻辑，无 Electron/DOM 依赖：类型、权限、业务引擎、版本比较、模板、演示数据。**所有业务规则写在这里并配测试。**
- `src/main/` Electron 主进程：窗口、IPC 白名单、JSON 存储。
- `src/preload/` 仅暴露一个 `window.nexus.call`。
- `src/renderer/` React 界面，只通过 `window.nexus.call` 访问数据。
- `tests/` 单元测试。

## 开发原则

1. 先保证核心流程可运行、数据可持久化，再做次要功能。
2. 业务规则和权限判断只放在 `src/shared`，界面层不重复实现权限逻辑，只用于显示/隐藏按钮。
3. 渲染进程收到的数据必须是 `buildViewState` 已过滤的结果，不得把完整数据库发给渲染进程。
4. 新增业务操作时：在 `service.ts` 实现并校验权限与输入 → 在 `api.ts` 加入白名单 → 在 `handlers.ts` 校验参数 → 补测试。
5. 不编造功能完成情况或测试结果。AI 助手相关输出必须标注“模拟AI输出”。
6. 所有企业名称、人员和合同内容必须虚构，不使用真实企业资料。

## 代码规范

- 使用 `.prettierrc.json`：两空格、单引号、不加分号、100 列、LF；提交前执行 `npm run format:check`。
- 迁移 SQL 的原始内容参与校验和：保留 `server/schema.sql` 和 TypeScript 模板字符串中的 SQL 原文。
- TypeScript `strict`，避免 `any`。
- 界面文字使用简体中文，提交信息使用英文。
- 组件保持小而清晰；跨页面复用的放 `components/`。
- 用户输入在 service 层校验（长度、格式、范围）。合同 HTML 经 `sanitizeHtml` 处理。

## 安全注意事项

- Electron：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，设置 CSP，拒绝所有权限请求，拦截导航与新窗口。
- 不向渲染进程暴露文件系统或任意 IPC。
- **本地账号切换不是真实认证**，不能被描述为生产级安全。
- 不硬编码密钥；`.env*` 不入库（`.env.example` 除外）。

## Git 规范

1. 每次开发前检查 Git 状态（`git status`）。
2. 不得随意覆盖未提交的用户修改。
3. 复杂功能优先在独立分支开发。
4. 每完成稳定功能后进行测试。
5. 测试通过后再提交 Git。
6. 使用清晰的英文 commit message（如 `Add transaction management`）。
7. 不得提交敏感资料（密钥、令牌、密码、真实合同/客户资料、本地数据库）。
8. 不得未经授权公开仓库。
9. 不得未经授权强制推送。
10. 不得未经授权删除远程分支。
11. 不得未经授权重写共享提交历史。
12. 不得未经授权使用破坏性 Git 操作，例如 `git reset --hard`、`git clean -fd`。
13. 如果新功能破坏旧功能，优先检查变更并利用 Git 安全恢复。
14. 每次开发完成后说明当前分支、最新提交和未提交修改。
15. 在首次 GitHub 连接完成并获得本次授权后，可以将后续通过测试的正常版本提交并推送到这个已确认的私有仓库。
16. 任何涉及仓库公开、权限扩大、删除历史或新增远程仓库的操作，都必须重新取得明确授权。

## 后续开发指引

优先级：P0 核心流程 > P1 协商中心/律师协作/履约/对比增强 > P2 AI、DOCX、电子签章。
下一步重点见 `ROADMAP.md`。
