# Team Model Routing（`dsh-plugin-team-model-routing`）

让 Agent Teams 的 **Lead** 在创建 teammate 时指定它的 `provider`、`model` 与
`reasoning_effort`，并按 Subagent 模型选择白名单校验。

## 为什么必须做成插件

官方 `spawn_teammate` 没有路由参数，而 `ctx.agentTeams.spawnTeammate()` 只把一个
provider 名字传给 `ctx.subagents.startContinuable()` —— `agentOptions` 在后者手里。

teammate 是 **continuable** 子代理：continuation registry 直接通过
`ctx.agents.create()` 物化它，**永远不会调用 subagent provider 的 `start()`**。
所以"包装一个 subagent provider"这个最直觉的做法根本路由不了一个 teammate ——
包装器压根不会被要求启动它，teammate 会静默落在继承来的路由上。

## 真正可用的接缝

```
spawn_teammate_routed            按 (Lead, teammate 名, context) 记录路由
        ↓
agentTeams.spawnTeammate(...)    官方 Team 服务，契约不变
        ↓
ctx.agents.create()              子代理物化；初始 prompt 进入 inbox
        ↓
agent/pre-step（子代理作用域）    ← 插件：claim 路由并改写 child.options
        ↓
AgentLoop.prepareRequest()       每步读 this.options → 进入 request/header、
                                 assistant 消息的 model source、以及后续每一步
```

成立的两个事实（都在已安装源码里核对过）：

- `agent/pre-step` 是 awaited waterfall，跑在 `step()` → `prepareRequest()` **之前**
  （`dsh-agent-loop/lib/index.js:902-925 → 978 → 1050`）。
- `prepareRequest()` **每一步**都重读 `this.options`
  （`dsh-agent-loop/lib/index.js:1168-1173`），且 loop 与 Agent 对象共享同一个
  `options` 引用（`:774`、`:1739`）。

反方向的顺序同样关键：子代理的初始 prompt 是 create **之后**才投递的，而 transcript
记录只在那一步内部才发生；所以 teammate 名字必须从该步的 claimed messages
（`payload.messages`）里取，transcript 只作 resume 的兜底。在 `agent/created` 时读
session 快照什么也读不到 —— 这是第一版实现的致命缺陷。

## 工具

| 工具 | 用途 |
|---|---|
| `spawn_teammate_routed` | 契约同 `spawn_teammate`，额外支持 `provider` / `model` / `reasoning_effort`。三个都不传即继承 Lead 路由。 |
| `list_teammate_models` | 列出可选 provider；给出 provider 后列出可选模型；再给出 model 后列出它的 reasoning efforts。 |

两者都装在 **Lead 自己的 Agent scope**（不装全局），teammate 看不到它们。

## 白名单

当 `@deepseek-ai/dsh-tool-subagent/model-selection-settings` 为 `enabled: true` 时，
`allowedModels` 之外的显式路由会在 teammate **被创建之前**拒绝。纯继承从不受限；
白名单 enabled 但为空时是所有路由都不可选，而不是连继承一起失败。

路由还会经过 `llm.resolveCallConfig()` 校验，所以未知模型或不支持的 effort 会直接
以 adapter 自己的报错失败，而不是拖到某个 turn 才炸。

## 配置

```yaml
- id: team-model-routing
  name: 'dsh-plugin-team-model-routing'
  config:
    toolName: spawn_teammate_routed
    listToolName: list_teammate_models
    freshProvider: spawn
    forkProvider: fork
    routeTtlMs: 120000
```

`freshProvider` / `forkProvider` 是交给官方 Team 服务的 provider 名，必须是已注册的
subagent provider（`spawn`、`fork`）。

## 已知限制

- **路由只存在于进程内存。** 它在子代理于本进程创建时生效。Harness **重启**后被冷
  resume 的 teammate 会退回其 `subagent/descriptor` 里记录的 `agentOptions`。要让它
  跨重启存活需要一份持久记录，这是自然的后续工作。
- **`agent.options` 是运行时对象**，不在公开的 `Agent` 接口里。正因为要改写它，这件事
  才只能做成插件而不是一行改动；上游的正解是让 provider 通过 `ContinuableCreateSpec`
  贡献 `agentOptions`（或让 Team 的 spawn 请求直接接受它）。上游仓库不接受外部 PR，
  所以路径是发布 `dsh-plugin` 并在 Discussions 提出这个 API 缺口。
- 一条从未被 claim 的路由（例如子代理存在之前就失败的 spawn）会在 `routeTtlMs` 后过期，
  无副作用。

## 测试

```sh
node packages/team-model-routing/test/logic.test.mjs
```

18 项检查，覆盖路由校验、白名单、发现渲染、claim 存储、名字提取。它只覆盖 `logic.js`
—— `agent/pre-step` 那个接缝需要真实运行才能验证。

## 安装

已发布到 npm：[`dsh-plugin-team-model-routing`](https://www.npmjs.com/package/dsh-plugin-team-model-routing)；
源码在 [Lingrui98/dsh-plugin-team-model-routing](https://github.com/Lingrui98/dsh-plugin-team-model-routing)。

```sh
npm install dsh-plugin-team-model-routing
```

或者让插件管理器指向已安装的包名 / 工作区目录：

```js
plugin_manager({ action: 'install_bundle', target: 'dsh-plugin-team-model-routing' })
```

安装只加载一次模块；由于 Node 按解析路径缓存 ES module，**替换本包代码需要重启
Harness** 才会在运行中的进程生效。

## 仓库结构

```
index.js            Cordis Host 插件：工具、路由钩子、Provider 装配
logic.js            零依赖的路由/claim 逻辑（有单测）
cordis.patch.yml    Loader patch：本插件行 + tool-agent-team 配置
locale/{en,zh}.json Plugin Manager 展示文案
test/logic.test.mjs 18 项逻辑测试（不打进 npm tarball）
```

`npm pack` 产物：`index.js`、`logic.js`、`cordis.patch.yml`、`icon.svg`、
`locale/*.json`、`LICENSE`、两个 README。

## 已实测

在 `desktop` profile、2026-10-15、profile 的 `subagentModelSelection` 白名单开启下观察：

| 验证点 | 证据 |
|---|---|
| 指定路由确实到达子代理 | `spawn_teammate_routed({ provider: 'model-server', model: 'glm-5.3', reasoning_effort: 'high' })` → host 日志 `team-model-routing: teammate "confirm-route" now runs on model-server/glm-5.3 (effort high)`；且 `list_agents` 里该 teammate 为 `model: "glm-5.3"`，而 Lead 是 `gpt-6.1-sol`、profile 默认是 `bosc/deepseek-flash` |
| `list_agents` 读回生效路由 | 被路由的 teammate 显示改写后的 `model`；在本插件之前创建的 teammate 则显示继承来的 `gpt-6.1-sol` |
| 白名单在创建前拦截 | `spawn_teammate_routed({ provider: 'bosc', model: 'gpt-5.6-luna' })` → `Error: teammate LLM route "bosc/gpt-5.6-luna" is not allowed by the Subagent model-selection allowlist; allowed: model-server/glm-5.3, kimi-code/k3, bosc/gpt-5.6-sol, model-server/kimi-k3, bosc/deepseek-flash`，没有创建 teammate |
| 两个工具都在 Lead 作用域生效 | `Tool.listTools` 同时列出 `spawn_teammate_routed`（含三个路由参数）与 `list_teammate_models` |

live 未覆盖：`fork` 上下文，以及 teammate 冷 resume 后的路由保持（见"已知限制"）。

## 发布新版本

本包是 `dsh-plugin` 形态：`dsh.bundle.patch` 指向 `cordis.patch.yml`，manifest 带
展示用 `meta`、`icon.svg`、`locale/{en,zh}.json`，并且是 `type: module`。发布流程：

1. 改 `package.json` 的 `version`（npm 不允许重复发布同一版本）。
2. `node test/logic.test.mjs` —— 18 项必须全过。
3. `npm pack --dry-run` —— 确认 tarball 就是「仓库结构」里列的 10 个文件。
4. `npm publish` —— npm 账号开了 2FA，所以要带 `--otp=<code>`，或改用勾了
   **bypass 2FA** 的 granular token。需要验证码时当场问，不要把它存下来。
5. `git commit` 并 `git push`。
6. 若包名有变，同步修改 `cordis.patch.yml` 里的 `name:` —— Loader 按这个字符串解析行。

## 推动上游修复

本包里的 `agent/pre-step` 改写，是在绕过一个缺失的上游扩展点：continuable 子代理的
provider 无法贡献 `agentOptions`，因为 continuable 子代理根本不会调用 provider 的
`start()`。如果该缺口被补上，本包保留工具与发现部分，删掉那段绕行即可。

上游仓库不接受外部 PR，所以提出方式是 GitHub Discussion。可直接发帖的文稿在工作区的
`proposal/` 目录（不打进 npm tarball）：

- `proposal/discussion-post.zh.md` —— 帖子正文（中文，可直接复制）。
- `proposal/upstream-continuable-agent-options.zh.md` —— 完整提案，含精确代码路径与测试点。
- `proposal/upstream-continuable-agent-options.md` —— 英文版。

发到 `deepseek-ai/deepseek-harness` → Discussions → **Show Your Plugins!**（介绍本包）
或 **Ideas**（提 API 缺口）。注意在该仓库建 Discussion 需要对它有写权限，外部贡献者
没有，所以这份文稿是给人手动粘贴用的。
