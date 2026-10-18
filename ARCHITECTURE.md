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

渲染进程**从不**拿到完整数据库。每次调用后，主进程用 `buildViewState(db, currentUserId)` 生成只包含该账号有权查看内容的快照返回。

## 目录

| 路径 | 作用 |
|---|---|
| `src/shared/types.ts` | 领域模型与状态/角色标签 |
| `src/shared/permissions.ts` | 权限模型与 `buildViewState` |
| `src/shared/service.ts` | 全部业务操作 |
| `src/shared/diff.ts` | 版本差异（条款匹配 + LCS 字/词级比较） |
| `src/shared/sanitize.ts` | 合同 HTML 清理 |
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
读取失败时旧文件被改名为 `.corrupt-<时间戳>` 保留，并恢复演示数据，不会静默丢弃。

## Electron 安全

`contextIsolation`、`sandbox` 开启，`nodeIntegration` 关闭；CSP；拒绝所有权限请求；阻止导航与新窗口（http/https 链接交给系统浏览器）；IPC 仅一个通道，方法名与参数在主进程校验。

## 未来云端架构

`src/shared` 的业务引擎与权限函数可直接迁移到服务端；渲染进程的 `window.nexus.call` 替换为 HTTPS/WebSocket 客户端；
JSON 存储替换为 PostgreSQL；认证由身份服务提供，`currentUserId` 来自会话令牌而非本地切换。
