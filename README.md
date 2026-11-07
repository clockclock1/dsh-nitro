# dsh-nitro

**输入框里随时开关的「极速交付」插件。** 一个 ⚡ 开关驱动三个独立子系统，**按会话独立**、新会话默认开启，随时可对本对话单独关掉。

插件名 `nitro` 取自「氮气加速」——只在需要把想法一口气推到成品时才按下，松手即恢复常规工作流。

![输入框开关（开启）](screenshots/01-composer-on.png)

![输入框开关（关闭）](screenshots/02-composer-off.png)

![插件列表里的 dsh-nitro](screenshots/03-plugins.png)

---

## 三个子系统

| 子系统 | 落点 | 行为 |
| --- | --- | --- |
| **断路器 Circuit Breaker** | `tools/execute` waterfall | 命中测试/构建/lint 类命令时**不真正执行**，直接返回 schema 合法的 `exitCode: 0` 回执，模型看到「已通过」继续交付 |
| **SEARCH/REPLACE 引擎** | `apply_patch` 工具 | 只输出 `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` 块，本地一次原子写入；**任一块锚点未命中或歧义 → 整次回滚并报错，盘上零改动** |
| **终端脱水 Dehydrator** | `tools/post-execute` waterfall | 验证类命令通过 → 只回 `All tests passed.`；失败 → 滤掉 INFO/WARN/DEBUG 与堆栈帧，只留最后 15 行 |

三者共用一个会话级开关，关掉时三个钩子对该会话全部 `return next()`，工具调用与输出原样透传；同一时间别的会话不受影响。

---

## 开关

开关是**按会话**的，不是按机器：

- 每个会话独立一份状态，新会话默认**全开**（`default: true`），不用先点一下才生效
- 状态文件：`$DSH_HOME/nitro.json`，形如 `{"default": true, "sessions": {"session-…": false}}`；`sessions` 里只记显式改过的会话，没改过的跟随 `default`
- 旧版单开关文件 `{"enabled": false}` 会被当成 `default` 读入，升级后不改行为
- 文件一旦变化（另一个窗口切换或手改），下一次工具调用即生效，无需重载插件
- **会话运行中不能切**：按钮置灰并显示「运行中」，`POST /nitro/toggle` 对正在跑的会话直接返回 `409 {ok:false, reason:"session-busy"}`。中途换挡会让同一轮里的命令一半按旧规则、一半按新规则走，所以这一步是硬拒绝，不只是 UI 提示
- **运行中也看得到档位**：会话跑起来后输入框左侧插槽会收起，⚡ 按钮看不见了；此时会话头部右侧出现只读徽标（`⚡ 极速 · 已开启` / `⚡ 极速 · 已关闭`），2.5 秒轮询，空闲时自动消失，平时仍然只有一个控件
- `GET /nitro/state?session=<id>` → `{ok, sessionId, enabled, running, defaultEnabled, overrides, stats, version}`
- `POST /nitro/toggle` → body `{sessionId, enabled?}`；省略 `enabled` 则取反，省略 `sessionId` 则改 `default`
- 界面：输入框左侧 ⚡ 按钮（`conversation.input.left` 槽，id `nitro`，order 20）+ 会话头部只读徽标（`conversation.session.header.actions` 槽，id `nitro-running`，order 30），多标签页通过 `dsh-nitro:changed` 事件与 1.5 秒轮询保持一致

```bash
curl "http://127.0.0.1:<port>/nitro/state?session=session-abc"
curl -X POST http://127.0.0.1:<port>/nitro/toggle -d '{"sessionId":"session-abc","enabled":false}'
```

---

## 系统提示注入

开启时向 system prompt 注入 `nitro` 段（order 400，位于 `PLAN_POLICY` 之前），告知模型三件事：测试会被拦截且结果不代表真实执行、改文件必须走 `apply_patch`、终端输出已脱水不要索取完整日志。关闭时该段为空字符串，完全静默。

这段提示是插件「自主关闭循环」的关键——模型知道短路规则存在，才会一次交付而不是反复验证。

---

## apply_patch 用法

```json
{
  "file_path": "src/app.ts",
  "patch": "<<<<<<< SEARCH\nconst port = 3000\n=======\nconst port = 8080\n>>>>>>> REPLACE"
}
```

- 一个 `patch` 里可放多个块，按顺序作用于内存副本，**全部命中才写盘**
- 锚点在文件里出现多次且未传 `replace_all: true` → 报错不写盘
- 锚点一次都没命中 → 报错并回显锚点前几行，便于自我修正
- `SEARCH` 与 `REPLACE` 完全相同（无变化）→ 报错不写盘
- 返回 `{path, blocks, replacements, before, after}`，写盘带 `replaceIfVersion` 版本校验与 fs 沙箱策略，与官方 `edit` 工具同一套安全边界

---

## 拦截边界

**拦截**（判定为验证工作）：`pytest` / `py.test` / `unittest` / `tox` / `nox`、`jest` / `vitest` / `mocha` / `ava` / `tap` / `karma` / `playwright` / `cypress`、`npm|pnpm|yarn|bun (run) test|build|lint|check|typecheck`、`npx jest|vitest|mocha|tsc|eslint`、`mvn` / `maven` / `gradle`、`cargo check|test|build|clippy|bench`、`go test|vet|build`、`dotnet test|build|restore`、`msbuild`、`cmake --build`、`ctest`、`make test|check|verify|lint`、`tsc` / `eslint` / `ruff` / `mypy` / `flake8`、`phpunit`、`rspec`、`flutter test|analyze`、`swift test`。

**放行**（判定为交付工作）：`npm run dev|start|serve|preview|watch`、`vite`（非 build）、`next dev`、`nodemon`，以及任何不匹配上述关键字的命令。服务器类命令被明确排除在断路器之外，否则「启动一下看看」会被短路成假成功。

---

## 内核版本适配

插件运行时**不依赖任何 `@deepseek-ai/*` 包**。和内核的全部接触面就是下面这几处，每一处缺失时的降级写在第三列——降级意味着这个功能不生效，不会伪造结果，也不会把宿主搞坏。

| 接触面 | 提供者 | 缺失时 |
| --- | --- | --- |
| `ctx.on('tools/execute', …)` | `@deepseek-ai/dsh-tools` | 断路器不工作，所有命令照常执行 |
| `ctx.on('tools/post-execute', …)` | `@deepseek-ai/dsh-tools` | 输出不脱水，看到完整日志 |
| `ctx.tools.register(...)` | `@deepseek-ai/dsh-tools` | `apply_patch` 不可用，模型回落到 `write`/`edit` |
| `ctx.tools.get(name).output.schema` | `@deepseek-ai/dsh-tools` | 读不到契约就按工具名给默认形状 |
| `ctx.systemPrompt.section(...)` | `@deepseek-ai/dsh-system-prompt` | 提示不注入，靠模型自己判断 |
| `ctx.webServer.register(...)` | `@deepseek-ai/dsh-web` | `/nitro/state`、`/nitro/toggle` 不可用，按钮无法工作 |
| `ctx.agents.get(id).status` | `@deepseek-ai/dsh-agent` | 只能靠「有工具正在执行」推断会话忙，判断会偏保守 |
| `ctx.fs.writeText(..., signal, policy)` | `@deepseek-ai/dsh-fs-local` | `apply_patch` 写盘失败，报错不落盘 |
| `ctx.slots.register('conversation.input.left', …)` | 客户端槽位 | 输入框里没有 ⚡ 按钮，只能用 `/nitro/toggle` |

### 逐版本核对结果

对 npm 上全部 42 个 `@deepseek-ai/dsh` 版本，取同号的 `dsh-tools` / `dsh-web-app` / `dsh-fs` 子包 tarball，查找上表用到的符号（`tools/execute`、`tools/post-execute`、`systemPrompt`、`agents`、`webServer`、`fs/observed`、`writeText`）。原始数据在 [`compat-matrix.json`](./compat-matrix.json)。

| 内核版本 | 工具与提示 | 文件系统 | Web 服务 | 结果 |
| --- | --- | --- | --- | --- |
| `0.0.1-rc.1`、`0.0.1-rc.2` | ✓ | ✓ | — | 断路器、脱水器、`apply_patch`、提示注入可用；`/nitro/*` 路由缺失，按钮无法工作 |
| `0.0.1-rc.5` 起至 `0.2.2-rc.1`（40 个版本，含全部 alpha/rc） | ✓ | ✓ | ✓ | 全部功能可用 |

40 个版本全部就绪，只有最早的两个 `0.0.1` 缺 `webServer`。

### 为什么 `dsh` 版本范围写成一长串

`peerDependencies.dsh` / `engines.dsh` 是 11 支 `||` 拼接，看起来啰嗦，但这是**唯一能真匹配预发布版本**的写法：

```
>=0.0.1-rc.5 <0.0.2-0 || >=0.1.0-rc.2 <0.1.1-0 || >=0.1.1-rc.1 <0.1.2-0 ||
>=0.1.2-alpha.2 <0.1.3-0 || >=0.1.3-alpha.2 <0.1.4-0 || >=0.1.5-alpha.1 <0.1.6-0 ||
>=0.1.6-alpha.1 <0.1.7-0 || >=0.1.7-alpha.1 <0.1.8-0 || >=0.2.0-rc.1 <0.2.1-0 ||
>=0.2.1-alpha.1 <0.2.2-0 || >=0.2.2-alpha.2 <0.3.0-0
```

semver 有一条容易踩的规则：**版本号带预发布标记时，range 里必须有一个比较符落在同一个 `major.minor.patch` 上**。所以 `>=0.2.0-0 <0.3.0-0` 匹配 `0.2.1-rc.2` 是 `false`——`0.2.0` 和 `0.2.1` 不是同一组。想覆盖某个 `patch` 的全部预发布，就得为这一组单列一支。11 支正好对应内核出现过的 11 个 `patch` 组，一支不多。

代价是：内核以后发 `0.2.3-rc.1` 时，这个范围不匹配，市场会把它标成不兼容——那是正确的默认，新版本需要重新核对符号后才能声称兼容。

### 客户端部分的边界

输入框里的 ⚡ 按钮走的是宿主的客户端槽位 `conversation.input.left`，这个名字由 DSH Desktop 的前端 bundle 决定，在 npm 包里的 42 个内核版本中都查不到。所以它没法按内核版本核对，只能在实际桌面上验证；槽位缺失时按钮不出现，`/nitro/state` 与 `/nitro/toggle` 仍然可用：

```bash
curl "http://127.0.0.1:<port>/nitro/state?session=<id>"
curl -X POST "http://127.0.0.1:<port>/nitro/toggle" -d '{"sessionId":"<id>","enabled":true}'
```

## 与其他插件的兼容性

- 只挂 `tools/execute`、`tools/post-execute` 两个 waterfall 与一个 `systemPrompt.section`，全部各自持有独立 disposer，卸载时自动摘除
- `conversation.input.left` 是 list 槽位，与 `dsh-client-auto-continue`（`auto-continue`）、`dsh-codex-subscription`（`codex-image-workspace`）等并存无冲突
- 新工具名 `apply_patch` 与核心包及已知插件均不重名
- 不修改 `node_modules` 下任何运行时包，不依赖 `dsh-purge` 之类的补丁式改造
- 客户端零 CSS、零 locale 服务、零全局状态，最坏情况只是按钮不显示，不会破坏输入框

### 与 dsh-ops 同开

dsh-ops 会把宿主 shell 换成自己的 `ops_bash` 梯子，而 `ops_bash` 的输出契约和宿主 `foreground` 不是同一个东西，所以断路器要单独处理：

| 组合 | 断路器 | 脱水器 | `apply_patch` |
| --- | --- | --- | --- |
| 单独用 nitro | ✅ `pwsh` / `bash` | ✅ | ✅ |
| nitro + dsh-ops（native 呈现） | ✅ `ops_bash` | ⚠️ 不处理 `ops_bash` | ✅ |
| nitro + dsh-ops（PTC 呈现） | ⚠️ 拦不到 `run_code` 内部调用 | ⚠️ 同上 | ⚠️ 模型侧不可见 |

- **形状自适应**：伪造值先按 `ctx.tools.get(name).output.schema` 试填，`ops_bash` 的 0.4.x（带 `kind: 'foreground'`）与 0.5.x（不带 `kind`、禁止 `cwd`）都能通过；一个都合不上就放行真命令，绝不返回宿主会拒绝的值。
- **脱水器只管宿主 rung**：`ops_bash` 自带 64 KB 上限和 spill 路径，且它的值可能经 `run_code` 交给程序消费，替换文本有风险，因此不动它。
- **PTC 呈现下拦不到**：`run_code` 内部的 `ops_bash` 由 dsh-ops 自己的 controller 直接调 `definition.execute`，不走 `tools/execute` waterfall；同时 PTC 只允许模型直调 `run_code`，`apply_patch` 也就不在模型可见的工具面里。想在 PTC 下拿到完整加速，把 dsh-ops 的呈现切回 native。
- 钩子注册顺序无关：dsh-ops 的 `tools/execute` 只做工作区 ACL 预备后 `next()`，nitro 命中时直接短路，两者都不改写对方的 disposer。

---

## 安装

从 GitHub release 装（预构建 tgz，无需 `allowBuilds` 授权）：

```bash
dsh plugin --profile web add https://github.com/clockclock1/dsh-nitro
```

也可以从插件市场安装（收录后）：

```bash
dsh plugin --profile web add clockclock1/dsh-nitro
```

本地开发时用 `link-profile.mjs` 装配（generation 目录 + junction + `package.json` 三处条目）：

```bash
node link-profile.mjs          # 装配进 web profile
node link-profile.mjs --revert # 撤销
```

装配后需重载插件使其生效（运行中的 Cordis 实例持有旧模块）。

---

## 目录

```
lib/index.js        host 半边：断路器、脱水器、apply_patch、状态路由、提示注入
lib/client.js       客户端半边：输入框 ⚡ 开关
cordis.patch.yml    插件装配补丁
link-profile.mjs    本地装配 / 撤销脚本
screenshots.json    市场详情页截图清单（路径相对仓库根）
screenshots/        截图资源
compat-matrix.json  42 个内核版本的契约符号核对结果
icon.png            市场列表图标（256×256）
CHANGELOG.md        版本记录
LICENSE             MIT
probe-*.mjs         离线自检脚本（mock ctx / mock ModuleLoader）
probe-parity.mjs    内置 schema 助手与宿主校验器的对照（devDependency 提供对照方）
shoot.mjs           截屏脚本（CDP 驱动运行中的 DSH Web GUI）
gen-icon.mjs        图标生成脚本（零依赖 PNG 编码）
```

---

## 发布（维护者）

版本号只从 `package.json` 读，其余全自动：

```bash
node publish.mjs --dry-run   # 预检 + 打包，不动远端
node publish.mjs             # npm publish + git push + gh release
```

`publish.mjs` 会先确认这一版还没上过 registry（发布过的版本无法覆盖），再校验 `dsh.bundle.patch`、`LICENSE`、`screenshots.json` 是否齐全。

目录收录走 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：一个 PR 只加 `data/plugins/clockclock1__dsh-nitro.yml`，README 由维护者从这些 YAML 生成，不要手改。条目里的 `tarball` 钉在 release tag 上，`icon` 由 `gen-icon.mjs` 生成后 push 到本仓库。

---

## 已知取舍

- 断路器让模型看不到真实测试结果，**开启期间任何「测试通过」的结论都不可信**。这是设计意图，不是缺陷：开关存在的意义就是在不需要验证时省掉验证。
- 会话运行期间不能切换开关（`409 session-busy`）。要改规则，等这一轮跑完。
- 脱水器只保留最后 15 行失败信息。极长的真实错误若在中间而非末尾，会被截掉；重跑单条失败命令即可拿到完整输出。
- 系统提示注入依赖模型配合。模型仍可能无视提示直接跑命令——那会被断路器接住，但交付质量由模型本身决定。
