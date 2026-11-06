# 更新日志

遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 1.0.4

开关从「全局一个」改成「每个会话一个」。

> 1.0.3 这个版本号在 npm 上发布后因 tarball 未落库被删除，同一版本号不可重用，因此本次发布改为 1.0.4。代码内容与下面列出的改动完全一致。

### 变更

- **按会话独立**：状态文件从 `{"enabled": bool}` 变为 `{"default": bool, "sessions": {"<sessionId>": bool}}`。没被显式改过的会话跟随 `default`，所以在一个对话里关掉极速模式不会影响另一个对话。
- **新会话默认开启**：`default` 为 `true`，装好即生效，不用先点一下。
- **旧文件自动迁移**：`{"enabled": false}` 被读成 `default: false`，升级后行为不变，不会因为换了形态就把"全局关"变成"全局开"。
- **运行中不可切换**：会话正在跑的时候，按钮置灰并显示「运行中」，`POST /nitro/toggle` 直接返回 `409 {ok:false, reason:"session-busy"}`。中途换挡会让同一轮里一半命令按旧规则、一半按新规则执行，所以这条是硬拒绝，不只是 UI 提示。
- 系统提示的 `nitro` 段改为按会话判定：关掉的会话不会再被要求「跳过测试」。
- 探针改为断言按会话语义（新会话默认开、单会话关闭不影响他人、运行中拒绝、旧文件迁移、提示段按会话）。

## 1.0.2

与 dsh-ops 同时启用时的兼容修正。

### 修复

- **`ops_bash` 不被拦截**：dsh-ops 的 `hidePwsh` 打开后，宿主不再暴露 `pwsh`，模型看到的唯一 shell 是 `ops_bash`。断路器此前只认 `pwsh` / `bash`，于是开关看着是开的，实际一条命令都没拦到。现在 `ops_bash` 也进拦截名单。
- **伪造结果被宿主判为非法输出**：`ops_bash` 有自己的输出契约（多 `status`、不允许 `cwd`，0.4.x 与 0.5.x 之间还不一样），照搬宿主 `foreground` 形状会被 `output.schema` 拒绝，报成 "returned invalid output" —— 本该是"跳过测试"，却变成"工具坏了"。现在候选形状按 `ctx.tools.get(name).output.schema` 实测挑选，全部不合就放行真命令，绝不伪造。

### 变更

- 脱水器仍然只处理宿主 `pwsh` / `bash`：`ops_bash` 自带 64 KB 上限与 spill 路径，且它的值可能经 `run_code` 交给程序消费，替换内容有风险。
- 新增 `probe-ops.mjs`：用 dsh-ops 0.4.x / 0.5.x 两套真实输出契约验证伪造值的合法性，并断言"schema 无法满足时不得伪造"。

## 1.0.1

市场兼容性与状态同步修正。功能与 1.0.0 相同，改动都在清单与状态刷新上。

### 修复

- **手改状态文件不生效**：此前 `nitro.json` 只在插件挂载时读一次，在另一个窗口切换、或直接编辑文件后，所有钩子都看不到变化，必须重载插件。现在每次用到时按 `(mtime, size)` 追踪文件变化并在变化时重读，`stateNow()` 成为唯一读点。
- **模块级状态声明缺失**：`state` / `stateStamp` 曾落在 `apply()` 闭包里，`stateNow()` 在模块作用域引用它们会抛 `ReferenceError: stateStamp is not defined`。两者已上移到模块作用域，重挂载也不会重置缓存。

### 变更

- 依赖声明拆分：`@deepseek-ai/dsh-tools` 同时作为 `dependencies`（裸导入 `defineTool` 需要它能被解析到）与 `peerDependencies`（`>=0.2.0-0 <0.3.0-0`，钉住插件实际测试过的宿主大版本）。此前把宿主精确版本 `0.2.1-rc.2` 写进 peer，会让任何其它 0.2.x 宿主被误判为不兼容。
- 随包提供 `package-lock.json`（lockfileVersion 3，根依赖钉 `0.2.1-rc.2`），避免安装时因预发布标签漂移到未验证的构建。
- `probe-plugin.mjs` 增加状态热重载断言（外部写文件 → 断路器立刻生效 → 再切换 → 立刻失效）。

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
