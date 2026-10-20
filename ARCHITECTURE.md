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

| 路径                                | 作用                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| `src/shared/types.ts`               | 领域模型与状态/角色标签                                  |
| `src/shared/permissions.ts`         | 权限模型与 `buildViewState`                              |
| `src/shared/service.ts`             | 全部业务操作                                             |
| `src/shared/diff.ts`                | 版本差异（条款匹配 + LCS 字/词级比较，先裁剪公共前后缀） |
| `src/shared/sanitize.ts`            | 合同 HTML 清理（标签白名单 + 丢弃全部属性）              |
| `src/shared/migrations.ts`          | 存储 schema 版本与升级链                                 |
| `src/shared/editorRules.ts`         | 编辑器规则（可见范围选项、确认最终版条件、版本排序）     |
| `src/shared/templates.ts` `seed.ts` | 虚构模板与演示数据                                       |
| `src/main/`                         | 窗口、IPC、`JsonStore`                                   |
| `src/preload/index.ts`              | 单一桥接函数                                             |
| `src/renderer/src/`                 | 页面、组件、Zustand store                                |

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

| 文件                                   | 职责                                                  |
| -------------------------------------- | ----------------------------------------------------- |
| `src/shared/events.ts`                 | 把结构化条款快照的差异变成带数值的领域事件            |
| `src/shared/finance.ts`                | 现金流测算。**纯计算，不调用模型**                    |
| `src/shared/context.ts`                | Claim（企业记忆单元）、Agent 上下文分发、事实晋升规则 |
| `src/shared/orchestrator.ts`           | 确定性 DAG + 三个标注的模型节点 + 人工确认闭环        |
| `src/shared/proposalView.ts`           | 建议中心的展示规则（陈旧判定、证据排序、状态文案）    |
| `src/renderer/src/pages/Proposals.tsx` | 待确认建议中心与企业记忆面板                          |

两条硬性规则：

1. **Agent 是主体，不是提示词。** Agent 从不拿到数据库，只拿到由 `buildViewState` 同一套权限函数裁剪出的 context bundle，其权限上限恒等于发起它的用户。`internal` 的内部意见之所以进不了财务 Agent，是因为它根本没被分发过去，而不是因为提示词要求保密。所有 Agent 都不接收评论与活动流，只接收结构化 Claim。
2. **事实、假设、建议分开存。** `Claim.status` 为 `confirmed | inferred | recommended`。只有人类确认能把 `inferred` 晋升为 `confirmed`；`inferred` 永不覆盖已确认事实（`mergeClaim`）；Agent 推理只能用 `confirmed` 作为前提（`selectPremises`）。这是阻止多个模型互相引用彼此猜测的唯一可靠闸门。

模型只用在需要判断的地方（法务与经营解读）和最终汇总；路由、算术、权限过滤都是普通代码。Agent 的产出一律是 `pending` 的 `Proposal`，带 `baseVersionId`，合同一旦被改动就拒绝批准（乐观并发）。

### 人工确认闭环

界面上的「AI 建议中心」是这条闭环的落点，规则同样写在 `src/shared` 里，因此可测：

- 每条建议列出它引用的 Claim，并按 `confirmed → inferred → recommended` 排序展示，状态徽章不同。
- 单条推断可以单独点「确认」晋升为事实（`confirmClaim` IPC），前提是它本来就在该用户的可见范围内——确认操作不能扩大可读范围。
- 建议「采纳」时，把它引用的推断一并晋升为已确认事实，并写入活动记录；「忽略」只标记状态。
- 陈旧建议（`isStaleProposal`）显示为失效并禁用采纳按钮，必须先重新分析；缺失依据同样禁用采纳，服务端在任何修改前校验全部依据，拒绝被替代的 Claim。
- 综合分析和建议处理仅限所属企业成员；外部律师继续参与合同协作，但不能读取或生成包含内部财务信息的综合建议。
- 分析使用开始时的数据快照及可见版本、成本与现金账户；异步返回后若源数据或当前身份变化，则拒绝写回。同一会话重叠运行时只有最新运行可以写回。
- Claim 合并后按实际保留的 ID 重建建议引用，审批与忽略成功后都会触发持久化。
- 重复运行同一份条款不会产生第二条相同建议（`isDuplicateProposal`），只更新已有结论。

## 服务端身份开发模式（尚未生产验收）

本地身份模式运行 Electron 主进程、Node API、PostgreSQL 和 OIDC Provider：

```text
Renderer -> Preload -> Electron Main (内存令牌)
                         |                  |
                   PostgreSQL API <--- OIDC 浏览器登录
                         |                  |
                  PostgreSQL         Keycloak + Mailpit
```

本地步骤见 [README.md](README.md#安装与启动)。Keycloak 开发 realm 由 `config/keycloak/nexus-realm.template.json` 导入；`node scripts/dev-services.mjs setup` 从未入库的 `.env` 注入 client secret，生成被忽略的 `.dev/keycloak/import/nexus-dev-realm.json`。redirect URI 必须是精确的 `http://127.0.0.1:4318/auth/callback`，OIDC issuer 也必须使用宿主机映射端口 `127.0.0.1:8080`，不能使用 Compose 内部服务名，否则浏览器与 API 端 issuer 不一致。

服务端从 `server/config.ts` 读取数据库、OIDC、回调、账号页和会话加密配置。登录 token 只在 Electron Main 进程内存中；进程重启会要求重新登录。服务器基于数据库中的身份、会话、成员关系和每次请求时的企业角色执行授权，不能信任 renderer 提交的 user/org/role 字段。

服务端业务存储通过 `003_scoped_business_storage` 从全局 `business_state` 迁为 12 类独立实体表：交易、合同、版本、评论、建议、交易消息、节点、活动、成本、现金账户、claims 和 proposals。各表保存单个实体 JSONB payload，以生成列、SQL 外键和索引表达身份、企业和交易关系；律师授权和方案依据另有桥表。迁移校验旧快照版本、完整集合、外键及跨交易/企业引用，失败整事务回滚，成功才删除旧表；不会隐式导入演示数据。

`businessStorage.ts` 先锁当前企业的独立业务 scope，再按交易 ID 顺序锁其拥有或已获邀的交易。读取用共享锁，写入用排他锁；同企业不同交易仍会串行。SQL 只加载当前企业作用域内的交易实体、自有现金账户、公司信息和自有 proposals，授权视图继续隐藏对方内部内容。服务端对完整的已加载模型做按 ID/payload 的差异保存，避免将 renderer 裁剪后的视图覆写成数据库真值，也不会删除未加载实体或全库重建。该隔离依赖 API 和作用域 SQL，没有启用 PostgreSQL RLS。

企业合作关系独立于交易，双方确认后才能创建新交易。规范化企业对行锁协调交叉申请、消息和断开操作；交易创建持有 accepted 关系共享锁直至提交。消息作者与所属企业取自服务端 principal，拒绝客户端伪造字段；审计仅保留动作和关系 ID，不保存消息正文。004 迁移在同一事务内锁表、核验历史消息归属并建立触发器，约束消息企业必须属于关系双方，禁止修改关系的 requester/recipient，发现历史脏数据则完整回滚。断开后禁止新交易和新伙伴消息，保留历史消息及已有交易、合同权限。

合同直接编辑使用条款内容快照 CAS：客户端提交开始编辑时的有序 `[id,title,body]`，服务端在赋值前比较当前条款，不一致返回 409。dirty 编辑器不随后台刷新更新 base，失败保留草稿，保存期间续写仍保留为未保存修改。该比较允许内容恢复原样的 ABA，不是递增版本门禁或自动合并。

`npm test` 使用 PGlite 在 Node 进程内运行 PostgreSQL WASM；验证真实 schema、SQL、事务回滚和授权逻辑。恢复专项另用磁盘数据目录验证重启、压缩备份、恢复到新目录和恢复后的继续写入；这不等同于独立 PostgreSQL 或 `pg_dump` 验收。多连接竞争、OIDC/SMTP 网络流程、浏览器回调、生产持久化和双设备验收仍待执行。

实时同步通过认证 SSE 发送不含业务正文的 `invalidate` 信号，由 Electron main 持有认证头并管理断线重连，preload 仅暴露失效订阅。renderer 收到信号后重新请求身份与授权业务视图；合同编辑器保留正在编辑的草稿。服务端以 REPEATABLE READ 短事务在一致快照中重新验证会话、成员和角色并读取可见内容摘要；目录摘要不采用全企业 audit 数量，避免不可见业务操作产生刷新信号。权限上下文变化时关闭旧流，不维护全平台 revision，也未使用 PostgreSQL LISTEN/NOTIFY。客户端保留 30 秒及窗口 focus 刷新作为补偿。
