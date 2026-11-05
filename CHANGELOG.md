# 更新日志

遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 1.0.0

首个公开发布版本。

### 新增

- **极速模式开关**：输入框左侧 ⚡ 按钮（`conversation.input.left` 槽，id `nitro`，order 20），默认关闭，跨会话保留。多标签页通过 `dsh-nitro:changed` 事件与 4 秒轮询保持一致。
- **断路器（Circuit Breaker）**：挂在 `tools/execute` waterfall 上，命中测试 / 构建 / lint 类命令时不真正执行，直接返回符合工具 `output.schema` 的 `exitCode: 0` 回执，`intercepted` 计数 +1。
- **SEARCH/REPLACE 局部替换引擎**：新增 `apply_patch` 工具，接受 `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` 冲突块，多块按序作用于内存副本，全部命中才一次原子写入；任一块锚点缺失或歧义则整次回滚、盘上零改动。
- **终端输出脱水（Dehydrator）**：挂在 `tools/post-execute` waterfall 上，验证类命令通过只回 `All tests passed.`；失败则滤掉 INFO / WARN / DEBUG / TRACE 噪声与堆栈帧，只留最后 15 行，`dehydrated` 计数 +1。
- **系统提示注入**：开启时向 system prompt 注入 `nitro` 段（order 400，位于 `PLAN_POLICY` 之前），告知模型测试会被拦截、改文件应走 `apply_patch`、终端输出已脱水。
- **HTTP 接口**：`GET /nitro/state`、`POST /nitro/toggle`。
- **状态文件**：`$DSH_HOME/nitro.json`，默认 `{"enabled": false}`。

### 安全边界

- `apply_patch` 写盘走官方同一套 `replaceIfVersion` 版本校验与 fs 沙箱策略（`sandboxPolicyFor` 与会话 cwd 对齐），不绕过沙箱。
- 服务器类命令（`npm run dev` / `vite` / `next dev` / `nodemon` 等）明确排除在断路器之外，避免「启动一下看看」被短路成假成功。
- 关闭时三个钩子全部放行，工具调用与输出原样透传；不修改 `node_modules` 下任何运行时包。

### 已知取舍

- 开启期间任何「测试通过」的结论都不可信——这是设计意图。
- 脱水只保留最后 15 行，极长错误若出现在中间会被截掉，重跑单条命令即可拿完整输出。
- 断路器依赖 `tools/execute` waterfall 的返回值得满足工具 `output.schema`；本版本按 `pwsh` / `bash` 的 `oneOf.foreground` 分支构造回执。
