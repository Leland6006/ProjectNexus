# ARCHITECTURE

## 总览

```
Renderer (React)  --window.nexus.call(method, ...args)-->  Preload  --IPC 'nexus:call'-->  Main
                                                                                             |
                                                                  handlers.ts (方法白名单 + 参数校验)
                                                                                             |
                                                          NexusService (业务规则 + 权限校验 + 输入校验)
                                                                                             |
                                                       Database (内存) --JsonStore--> nexus-data.json
```

渲染进程**从不**拿到完整数据库。每次调用后，主进程用
`buildViewState(db, currentUserId, { representingOrgId, demoDirectory })` 生成只包含该账号有权查看内容的快照返回。

- `representingOrgId`：外部律师被双方同时授权时指定当前代表哪一方，否则只能看到第一个授权方的数据。
- `demoDirectory`：仅本地演示开启，额外返回全部演示账号供左下角切换器使用；服务端必须保持关闭。
- 默认返回的 `users` / `organizations` 只含与可见交易相关的组织、以及可见内容的作者，避免把整个客户名单发给每个客户端。

## 目录

| 路径 | 作用 |
|---|---|
| `src/shared/types.ts` | 领域模型与状态/角色标签 |
| `src/shared/permissions.ts` | 权限模型与 `buildViewState` |
| `src/shared/service.ts` | 全部业务操作 |
| `src/shared/diff.ts` | 版本差异（条款匹配 + LCS 字/词级比较，先裁剪公共前后缀） |
| `src/shared/sanitize.ts` | 合同 HTML 清理（标签白名单 + 丢弃全部属性） |
| `src/shared/migrations.ts` | 存储 schema 版本与升级链 |
| `src/shared/editorRules.ts` | 编辑器规则（可见范围选项、确认最终版条件、版本排序） |
| `src/shared/templates.ts` `seed.ts` | 虚构模板与演示数据 |
| `src/main/` | 窗口、IPC、`JsonStore` |
| `src/preload/index.ts` | 单一桥接函数 |
| `src/renderer/src/` | 页面、组件、Zustand store |

## 数据模型

Organization、User、Transaction、Contract、ContractVersion、Comment、Suggestion、Message、Milestone、Activity。
`Transaction` 是根对象：合同、消息、履约节点、活动都通过 `transactionId` 归属于交易。
`Contract.clauses` 是工作草稿；`ContractVersion` 是不可变快照；`Suggestion` 记录提议时的原文，接受时若条款已变则拒绝（防止覆盖）。

## 权限模型（本地演示）

- **有效企业**：当事人成员代表自己的企业；外部律师代表授权他的企业。交易对方在被邀请前看不到该交易。
- **可见范围**：`shared` 双方可见；`internal` 仅作者企业（外部律师也不可见）；`counsel` 作者企业及其授权律师。
- **合同**：发起方始终可见；对方仅在合同被共享后可见，且看不到共享之前产生的版本与活动。
- **修改权**：只有发起方成员可编辑合同草稿、保存/恢复版本；对方通过“修改建议”，由对方企业的另一方接受/拒绝（不能自己批准自己的建议）。
- **脱敏**：对方看不到己方的律师授权记录与邀请律师的活动。
- **最终版**：必须是最新版本，双方企业各自确认后合同锁定；保存新版本或接受建议会清除确认。

> 这只是本地演示：账号切换没有认证，数据文件是明文 JSON。真实隔离必须由服务端强制（V0.2）。

## 本地存储

单个 `nexus-data.json`（Electron `userData` 目录），写入使用“临时文件 + rename”原子替换，文件权限 600，写入防抖 150ms，退出时 flush。

`src/shared/migrations.ts` 持有 schema 版本与升级链：`CURRENT_SCHEMA_VERSION` 随 `Database` 结构变化递增，每个 `MIGRATIONS` 条目负责一步升级。
读取时按版本逐级迁移，迁移结果立即写回磁盘。**只有**文件无法解析（改名 `.corrupt-<时间戳>`）或缺少迁移步骤、来自更新版本（改名 `.incompatible-<时间戳>`）时才会归档并恢复演示数据——不会静默丢弃用户数据。

## Electron 安全

`contextIsolation`、`sandbox` 开启，`nodeIntegration` 关闭；CSP；拒绝所有权限请求；阻止导航与新窗口（http/https 链接交给系统浏览器）；IPC 仅一个通道，方法名与参数在主进程校验。

## Nexus Context Engine（V0.2）

目标：不同专业的 Agent 围绕同一家企业、同一笔交易协同，而不是各自回答孤立问题。它建立在既有业务对象之上，不推翻它们。

| 文件 | 职责 |
|---|---|
| `src/shared/events.ts` | 把结构化条款快照的差异变成带数值的领域事件 |
| `src/shared/finance.ts` | 现金流测算。**纯计算，不调用模型** |
| `src/shared/context.ts` | Claim（企业记忆单元）、Agent 上下文分发、事实晋升规则 |
| `src/shared/orchestrator.ts` | 确定性 DAG + 三个标注的模型节点 + 人工确认闭环 |

两条硬性规则：

1. **Agent 是主体，不是提示词。** Agent 从不拿到数据库，只拿到由 `buildViewState` 同一套权限函数裁剪出的 context bundle，其权限上限恒等于发起它的用户。`internal` 的内部意见之所以进不了财务 Agent，是因为它根本没被分发过去，而不是因为提示词要求保密。所有 Agent 都不接收评论与活动流，只接收结构化 Claim。
2. **事实、假设、建议分开存。** `Claim.status` 为 `confirmed | inferred | recommended`。只有人类确认能把 `inferred` 晋升为 `confirmed`；`inferred` 永不覆盖已确认事实（`mergeClaim`）；Agent 推理只能用 `confirmed` 作为前提（`selectPremises`）。这是阻止多个模型互相引用彼此猜测的唯一可靠闸门。

模型只用在需要判断的地方（法务与经营解读）和最终汇总；路由、算术、权限过滤都是普通代码。Agent 的产出一律是 `pending` 的 `Proposal`，带 `baseVersionId`，合同一旦被改动就拒绝批准（乐观并发）。

## 未来云端架构

`src/shared` 的业务引擎与权限函数可直接迁移到服务端；渲染进程的 `window.nexus.call` 替换为 HTTPS/WebSocket 客户端；
JSON 存储替换为 PostgreSQL；认证由身份服务提供，`currentUserId` 来自会话令牌而非本地切换。
