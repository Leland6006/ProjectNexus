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
| `src/shared/chat.ts` | Nexus 会话的长度限制、标题与搜索、`NexusRuntime` 运行适配边界 |
| `src/shared/briefing.ts` | “需要关注 / 今日经营”：只从可见数据生成、每项带来源 |
| `src/renderer/src/routes.ts` | 类型化路由（模块 → 对象 → 工作内容）与身份变化后的路由校正，无依赖、可测试 |
| `src/shared/templates.ts` `seed.ts` | 虚构模板与演示数据 |
| `src/main/` | 窗口、IPC、`JsonStore` |
| `src/preload/index.ts` | 单一桥接函数 |
| `src/renderer/src/` | 页面、组件、Zustand store |

## 数据模型

Organization、User、Transaction、Contract、ContractVersion、Comment、Suggestion、Message、Milestone、Activity；
协同分析另有 Claim、Proposal、CostItem、CashAccount；第一轮新增 Conversation、ChatMessage（schema v3）。
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
| `src/shared/proposalView.ts` | 建议中心的展示规则（陈旧判定、证据排序、状态文案） |
| `src/renderer/src/pages/Proposals.tsx` | 待我决策 / 已处理（方案卡与依据） |
| `src/renderer/src/pages/Memory.tsx` | 公司档案与记忆（已确认 / 待核实 / 历史记录） |

两条硬性规则：

1. **Agent 是主体，不是提示词。** Agent 从不拿到数据库，只拿到由 `buildViewState` 同一套权限函数裁剪出的 context bundle，其权限上限恒等于发起它的用户。`internal` 的内部意见之所以进不了财务 Agent，是因为它根本没被分发过去，而不是因为提示词要求保密。所有 Agent 都不接收评论与活动流，只接收结构化 Claim。
2. **事实、假设、建议分开存。** `Claim.status` 为 `confirmed | inferred | recommended`。只有人类确认能把 `inferred` 晋升为 `confirmed`；`inferred` 永不覆盖已确认事实（`mergeClaim`）；Agent 推理只能用 `confirmed` 作为前提（`selectPremises`）。这是阻止多个模型互相引用彼此猜测的唯一可靠闸门。

模型只用在需要判断的地方（法务与经营解读）和最终汇总；路由、算术、权限过滤都是普通代码。Agent 的产出一律是 `pending` 的 `Proposal`，带 `baseVersionId`，合同一旦被改动就拒绝批准（乐观并发）。

### 人工确认闭环

界面上的「行动与决策 → 待我决策」和「公司档案与记忆」是这条闭环的落点，规则同样写在 `src/shared` 里，因此可测：

- 每条建议列出它引用的 Claim，并按 `confirmed → inferred → recommended` 排序展示，状态徽章不同。
- 单条推断可以单独点「确认」晋升为事实（`confirmClaim` IPC），前提是它本来就在该用户的可见范围内——确认操作不能扩大可读范围。
- 建议「采纳」只记录决策、生成合同修改建议并写入活动记录，**不改变**它引用的任何 Claim：采纳一个方案不等于确认预测已经发生，建议也仍是建议。推断只能通过「确认」逐条晋升为事实。「忽略」只标记状态。
- 陈旧建议（`isStaleProposal`）显示为失效并禁用采纳按钮，必须先重新分析；缺失依据同样禁用采纳，服务端在任何修改前校验全部依据，拒绝被替代的 Claim。
- 综合分析和建议处理仅限所属企业成员；外部律师继续参与合同协作，但不能读取或生成包含内部财务信息的综合建议。
- 分析使用开始时的数据快照及可见版本、成本与现金账户；异步返回后若源数据或当前身份变化，则拒绝写回。同一会话重叠运行时只有最新运行可以写回。
- Claim 合并后按实际保留的 ID 重建建议引用，审批与忽略成功后都会触发持久化。
- 重复运行同一份条款不会产生第二条相同建议（`isDuplicateProposal`），只更新已有结论。

## 界面与路由（第一轮）

从左到右：一级模块导航 → 可折叠二级侧栏 → 主内容区。`Route` 是带判别字段的联合类型（`module` + `view` + 对象 id），
所有跳转都经过 `navigate`：

- 每个模块记住上次的页面，切回时恢复；一次性的标记（如“打开新建对话框”）不会被记住。
- 切换账号或重置演示数据时，路由、各模块记录和离开保护全部清空，回到 Nexus 首页。
- 同一账号下数据变化后，`reconcileRoute` 把指向已不可见对象的路由退回模块默认页。
- 合同编辑器有未保存修改时，任何离开方式（返回、侧栏、切换模块或账号）都会先确认。
- 进入合同编辑器时自动收起二级侧栏，离开后恢复原来的状态。
- “当前经营企业”在侧栏底部和顶栏显示；“交易对象”只是业务的分组条件，每笔业务的合同、磋商与收付款各自独立。

## Nexus 对话与运行适配边界

- `Conversation` 归属一个账号和它所在的经营企业。`buildViewState` 只返回本人、本企业的会话，同企业的同事也看不到；
  访问他人会话一律返回“不存在”。
- 会话在发送第一条消息时才创建，不保存空草稿；演示数据不预置任何聊天记录。
- 聊天服务方法只写 `conversations` 和 `chatMessages`，**不会**写入 Claim 或其他业务数据。
- 主进程持有一个 `NexusRuntime`（`src/shared/chat.ts`）。本版本是 `NO_RUNTIME`：每条消息只得到一条 `system` 状态说明
  “尚未连接 AI”，不会生成 `assistant` 回复。运行时出错时同样写入状态说明。
- 回复异步返回时如果当前账号已切换，丢弃回复，不写入。
- 后续接入模型 API 或 DeepSeek Harness 时，只替换 `setRuntime(...)` 注入的对象；运行时想修改任何业务数据，
  仍必须通过 `NexusService` 的权限与输入校验，不能只依赖提示词。

## 未来云端架构

`src/shared` 的业务引擎与权限函数可直接迁移到服务端；渲染进程的 `window.nexus.call` 替换为 HTTPS/WebSocket 客户端；
JSON 存储替换为 PostgreSQL；认证由身份服务提供，`currentUserId` 来自会话令牌而非本地切换。
