# Team Model Routing (`dsh-plugin-team-model-routing`)

Let an Agent Teams **Lead** choose the `provider`, `model`, and
`reasoning_effort` of each teammate it spawns, validated against the Subagent
model-selection allowlist.

## Why it needs a plugin

`spawn_teammate` (shipped) carries no route fields, and
`ctx.agentTeams.spawnTeammate()` forwards only a provider *name* to
`ctx.subagents.startContinuable()`, which is where `agentOptions` live.

A teammate is a **continuable** child: the continuation registry materializes it
through `ctx.agents.create()` and **never calls a subagent provider's
`start()`**. So wrapping a subagent provider (the obvious first idea) can never
route a teammate — the wrapper is simply never asked to start it, and the
teammate silently ends up on the inherited route.

## The seam that works

```
spawn_teammate_routed            record route by (Lead, teammate name, context)
        ↓
agentTeams.spawnTeammate(...)    shipped Team service, unchanged contract
        ↓
ctx.agents.create()              child materialized; initial prompt queued to inbox
        ↓
agent/pre-step (child scope)     ← plugin: claim route, rewrite child.options
        ↓
AgentLoop.prepareRequest()       reads this.options → request/header + assistant
                                 message source + every later step
```

Two facts make this work, both verified in the installed sources:

- `agent/pre-step` is an awaited waterfall that runs **before** `step()` →
  `prepareRequest()` (`dsh-agent-loop/lib/index.js:902-925 → 978 → 1050`).
- `prepareRequest()` reads `this.options` on **every** step
  (`dsh-agent-loop/lib/index.js:1168-1173`), and the loop and the Agent object
  share one `options` reference (`:774`, `:1739`).

The order matters in the other direction too: the child's initial prompt is
submitted *after* creation and the loop appends it to the transcript only
*inside* that first step, so the teammate name must be read from the step's
claimed messages (`payload.messages`), with the transcript as a fallback for a
resumed teammate. Reading the session snapshot at `agent/created` time finds
nothing — that was the first implementation's fatal flaw.

## Tools

| Tool | Purpose |
|---|---|
| `spawn_teammate_routed` | Same contract as `spawn_teammate`, plus `provider` / `model` / `reasoning_effort`. Omit all three to inherit the Lead route. |
| `list_teammate_models` | Lists selectable providers, then selectable models for one provider, then that model's reasoning efforts. |

Both are installed in the **Lead's own Agent scope** (never globally), so
teammates do not see them.

## Allowlist

When `@deepseek-ai/dsh-tool-subagent/model-selection-settings` is
`enabled: true`, explicit routes outside `allowedModels` are rejected **before**
the teammate is created. Pure inheritance is never restricted. An enabled but
empty allowlist makes every route unselectable rather than failing inheritance.

The route is also validated through `llm.resolveCallConfig()`, so an unknown
model or an unsupported reasoning effort fails with the adapter's own message
instead of surfacing later as a failed turn.

## Config

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

`freshProvider` / `forkProvider` are the provider names handed to the shipped
Team service; they must name registered subagent providers (`spawn`, `fork`).

## Known limits

- **The route is process-local.** It lives in the plugin's memory, so it applies
  while the child is created in this process. A teammate cold-resumed after a
  Harness **restart** falls back to the `agentOptions` recorded in its
  `subagent/descriptor`. Making that survive a restart needs a durable record and
  is the natural follow-up.
- **`agent.options` is a runtime object**, not part of the public `Agent`
  interface. The rewrite is the reason this stays a plugin rather than a
  one-line change; upstream, the clean fix is to let the provider contribute
  `agentOptions` through `ContinuableCreateSpec` (or to accept `agentOptions` on
  the team spawn request). The upstream repository does not accept external PRs
  — publish this as a `dsh-plugin`, and raise the API gap in Discussions.
- A recorded route that is never claimed (a spawn that failed before the child
  existed) expires after `routeTtlMs` and is harmless.

## Test

```sh
node packages/team-model-routing/test/logic.test.mjs
```

18 checks over route validation, allowlist enforcement, discovery rendering, the
claim store, and teammate-name extraction. It covers `logic.js` only — the
`agent/pre-step` seam itself needs a live run.

## Install

```js
plugin_manager({ action: 'install_bundle', target: '<abs path to this package>' })
```

Installing loads the module once; because Node caches ES modules by resolved
path, **replacing this package's code requires a Harness restart** to take
effect in a running process.

## Verified live

Observed on the `desktop` profile, 2026-10-15, with the profile's
`subagentModelSelection` allowlist enabled:

| Check | Evidence |
|---|---|
| Route reaches the child | `spawn_teammate_routed({ provider: 'model-server', model: 'glm-5.3', reasoning_effort: 'high' })` → host log `team-model-routing: teammate "confirm-route" now runs on model-server/glm-5.3 (effort high)`, and `list_agents` reported that teammate as `model: "glm-5.3"` while the Lead was `gpt-6.1-sol` and the profile default is `bosc/deepseek-flash`. |
| `list_agents` reads the applied route | `list_agents` shows the rewritten `model` for the routed teammate, and `gpt-6.1-sol` (the inherited route) for teammates created before this plugin existed. |
| Allowlist rejects before creation | `spawn_teammate_routed({ provider: 'bosc', model: 'gpt-5.6-luna' })` → `Error: teammate LLM route "bosc/gpt-5.6-luna" is not allowed by the Subagent model-selection allowlist; allowed: model-server/glm-5.3, kimi-code/k3, bosc/gpt-5.6-sol, model-server/kimi-k3, bosc/deepseek-flash` — no teammate was created. |
| Both tools are live in the Lead scope | `Tool.listTools` lists `spawn_teammate_routed` (with `provider`/`model`/`reasoning_effort`) and `list_teammate_models`. |

Not covered by the live run: the `fork` context, and route survival across a
teammate cold-resume (see Known limits).

## Publishing this as a community package

The package is already `dsh-plugin` shaped: `dsh.bundle.patch` points at
`cordis.patch.yml`, the manifest carries display `meta`, `icon.svg` and
`locale/{en,zh}.json`, and it is `type: module`. Before `npm publish`:

1. Add the remaining npm metadata to `package.json` — `repository`, `homepage`,
   `bugs`, `author`. None of them is set here, because only you know the URL your
   fork or repository will live at.
2. Check the name is still free: `npm view dsh-plugin-team-model-routing version`.
   If it is taken, scope it (for example `@your-scope/dsh-plugin-team-model-routing`)
   and update the `name:` line in `cordis.patch.yml` to match — the Loader resolves
   the row by that string.
3. Build the tarball and inspect exactly what ships:
   `npm pack --dry-run` (expected: `index.js`, `logic.js`, `cordis.patch.yml`,
   `icon.svg`, `locale/*.json`, `LICENSE`, `README.md`, `README.zh.md`,
   `package.json`).
4. Publish, then add the [`dsh-plugin`](https://github.com/topics/dsh-plugin)
   topic to the repository so it can be found.

Installing the published package is then the documented path:

```sh
dsh plugin add dsh-plugin-team-model-routing   # or: plugin_manager install_bundle
```

### Inviting the upstream fix

The `agent/pre-step` rewrite in this package is a workaround for a missing
upstream extension point: a continuable-subagent provider cannot contribute
`agentOptions`, because the provider's `start()` is never called for continuable
children. If that gap is closed, this package keeps its tools and drops the
workaround.

The upstream repository does not accept external PRs, so the way to raise it is a
GitHub Discussion. Ready-to-post write-ups live next to this repository:

- `proposal/discussion-post.zh.md` — the post itself (Chinese, copy-paste).
- `proposal/upstream-continuable-agent-options.zh.md` — full proposal with the
  exact code paths and test points.
- `proposal/upstream-continuable-agent-options.md` — the same in English.


