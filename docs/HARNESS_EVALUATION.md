# DeepSeek Harness 接入验证（2026-10-19）

本轮结论：保留可替换运行适配边界，暂不启用 Harness，不把它列为已完成集成。

## 已执行

- 阅读官方 `packages/sdk/client/README.md` 与 SDK 类型声明。
- npm 查询结果：`@deepseek-ai/dsh-sdk-client` 为 `0.0.1-rc.1`；`@deepseek-ai/dsh` 最新为 `0.2.1-rc.2`。
- 在独立临时目录下载并检查 `dsh-sdk-client@0.0.1-rc.1` 发布包，不向项目增加依赖。
- 尝试安装匹配的 client/protocol/runtime `0.0.1-rc.1`，使用 `--ignore-scripts --legacy-peer-deps`，未提供真实企业数据或 API Key。
- 安装失败：npm registry 返回 `E404`，`@deepseek-ai/dsh-agent-tool-mode@^0.0.1-rc.1` 不存在。

## 尚未通过的验收

真实 Harness 运行时的模型回合、工具白名单、审批、中断恢复和 Electron 打包均未通过实测，不能宣称已集成。官方最新 SDK 文档还明确记录：没有回合内取消方法，中止需关闭运行时；server-to-client requests 尚未实现，后续审批流程不能只依赖这一通道。

## Nexus 当前实现

Nexus 自己保存权限受控的分析记录和节点检查点；直接模型 API 负责专业解读。用户采纳后，经业务服务生成真实任务。暂停、恢复、去重、结果记录与权限检查由 Nexus 实现，不依赖 Harness 是否可安装。

后续先选择可安装、相互匹配的稳定 SDK/runtime 版本，再在独立运行目录只暴露业务工具；以 SDK 安装、启动与退出、权限、人工确认、重复执行、打包恢复为接入门槛。不得直接开放 shell、任意文件或数据库写入来绕过工具边界。

来源：
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/src/types.ts
