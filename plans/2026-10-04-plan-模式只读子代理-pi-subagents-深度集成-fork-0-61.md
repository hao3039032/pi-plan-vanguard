# Plan 模式只读子代理 + pi-subagents 深度集成（fork 0.61.0，v5 审核修订版，完整替换）

## 摘要

pi-plan-mode 自带 Plan 专用只读侦察子代理 **`plan-scout`**，并与 pi-subagents 深度集成。Plan 模式对 `subagent` 工具做**按调用细粒度豁免**（自动放行），不使用 capability ceiling：

- **豁免形状**：单孩（`agent`+`task`）、静态多孩（`tasks`/`chain`，严格校验每项字段）、`action: "capabilities"`；`workflow: true` 脚本**仅在用户显式开启 `planAdmitWorkflowScripts` 时**放行（完全信任声明）。
- **调用参数白名单**：非脚本豁免一律要求参数只含安全键；`gate`/`acceptance`/`share`/`worktree`/`isolation`/`sessionDir`/`machine`/`cwd`/字符串 `output` 等宿主副作用参数出现即不豁免。
- **每个被引用 agent 必须通过三条路径之一**：plan-scout（自持定义、无同名冲突）/ `planAdmittedAgents`（强制名单）/ **验证式只读**（preflight 显式工具白名单 ⊆ 只读集合 + 无子扩展 + 定义文件无 runner/machine/acceptance/危险 output）。

前置：先完成进行中的 0.60.0 吸收变更集。

## 审核修订要点（相对 v4）

1. **宿主侧副作用**：孩子工具面只读不足以保证安全——`gate`、`acceptance.verify`（宿主 `spawn(shell:true)`）、`output` 绝对/`..` 路径（宿主 `writeFileSync`）、`share`（Gist 上传）、`worktree`/`isolation`（`git worktree add`）、`sessionDir`、`machine` 都在宿主执行。→ 新增调用参数白名单与 agent 定义文件守卫。
2. **空白名单误放行**：无 `tools` 字段的 agent（含 `claude-code`/`claude-code-writer` external-cli）`effectiveAllowlist` 为空，原"全部工具 ∈ 只读集"空真成立。→ 强制 `explicitAllowlist === true` 且拒绝 `runner`/`machine`。
3. **注册冲突会瘫痪 pi-subagents**：`mergeRuntimeAgents` 在每次 agent 发现时对运行时 agent 与已配置 agent 同名抛错。→ 注册前 preflight 预检冲突，冲突则不注册。
4. **子扩展代码执行**：agent 配置的 extensions 在子进程执行任意代码。→ 验证要求 `configuredExtensions`/`toolExtensionPaths` 为空。
5. **去掉 capability ceiling**（会话级副作用，影响用户显式选中调用与 Plan 前运行）。
6. **workflow 脚本**：静态/预跑分析不可靠（脚本按孩子输出分支），无 ceiling 后无法约束脚本 spawn 集合与 `runs.run` 内的 gate/output → 仅显式开关放行。
7. 测试策略修正：判定逻辑抽为纯函数做 standalone 测试；hook 集成测试随 monorepo 套件。

## 探查依据（已验证）

- 运行时注册事件 `pi-subagents:runtime-agent-register:v1`（同步、回填 `request.result`）；注册的 agent 与 builtin/package/user/project 配置 agent 同名或同别名 → `assertNoConfiguredCollision` 在每次发现时抛错。
- `pi-subagents/preflight` → `resolveSubagentLaunchContract({agent, cwd})`：返回 `agent.filePath`、`tools.explicitAllowlist`、`tools.effectiveAllowlist`、`tools.configuredExtensions`、`tools.toolExtensionPaths`、诊断码（missing/ambiguous_agent 等）；经 pi jiti virtualModules 链可 import。
- 子会话：`explicitToolAllowlist` 为真时才传 `tools` 白名单；否则孩子拿 Pi 默认工具（含 bash/edit/write）。
- 宿主执行点：`acceptance.js:1375` `spawn(shell:true)`；`single-output.js:74/218` 绝对 output 直写；`schemas.js` 的 `gate`/`share`/`worktree`/`isolation`/`sessionDir`/`machine`/`cwd`。
- 子会话工具约束只覆盖工具面，不覆盖上述调用参数与 agent 级 `runner`/`defaultAcceptance`。

## 行为变更（按行为分组）

### 1. plan-scout 注册（新增 `src/plan-scout.ts`）
- 定义：`description`（只读代码侦察）、`systemPrompt`（replace：定向探索、file:line 证据、不改文件、压缩 handoff）、`tools: ["read","grep","find","ls"]`、`systemPromptMode: "replace"`、`inheritProjectContext: true`、`inheritSkills: false`、`thinking: "low"`、`defaultProgress: true`（**不设 `output` 默认值**，避免产物路径歧义；结果走工具返回）。
- `ensurePlanScoutRegistered(pi, ctx)`：
  1. 若 preflight 可用，先 `resolveSubagentLaunchContract({agent:"plan-scout", cwd})`；结果 ok 或 ambiguous（说明存在已配置同名 agent）→ **不注册**，状态 `collision`。
  2. 无冲突 → emit 注册事件；回填 ok → `registered` 并持有 dispose；未回填/失败 → `unavailable:<reason>`。
  3. 时机：`session_start` 与每次 Plan 工作流启动（未注册时重试；已注册时复查冲突，新出现冲突 → 立即 dispose 并转 `collision`）。`session_shutdown` 时 dispose。
  4. preflight 不可用时不能预检冲突 → 仍注册（冲突概率低），doctor 标注"collision check unavailable"。
- `planScoutStatus()`：`registered | collision | unavailable:<reason>`。

### 2. subagent 按调用豁免 — `src/plan-scout.ts`（纯函数）+ `src/plan-mode.ts`（接线）
- 接线位置：tool_call 拦截中 availability/classify 之后、`!allowedToolNames.has` 拦截之前；`event.toolName === "subagent"` 且 `decideDelegationAdmission(...)` 为 admit → 按调用放行（不进 allowlist、不持久化），`trackPlanCall`。
- **`action` 调用**：仅 `action === "capabilities"` 且无其他执行键 → admit；其余 action → 不豁免。
- **`workflow: true`**：仅 `settings.planAdmitWorkflowScripts === true` → admit（不检查脚本、参数、agent；完全信任）；否则不豁免。
- **单孩/静态多孩调用参数白名单**（出现白名单外任何键即不豁免）：`agent`、`task`、`tasks`、`chain`、`context`（fresh/fork）、`model`、`thinking`、`async`、`timeoutMs`、`maxRuntimeMs`、`toolBudget`、`includeProgress`、`chatProgress`、`artifacts`、`skill`、`output`（仅允许 `false`）、`acceptance`（仅允许 `false`）。
- **结构校验**：单孩要求 `agent` 与 `task` 均为非空字符串；`tasks` 每项键 ⊆ `{agent, task}`；`chain` 每步键 ⊆ `{agent, task, as}` 或恰为 `{parallel}`，`parallel` 每项键 ⊆ `{agent, task}`；不能同时出现单孩与多孩字段；任何畸形 → 不豁免。
- **逐 agent 判定**（全部通过才 admit）：
  1. `plan-scout` 且状态 `registered`；
  2. ∈ `settings.planAdmittedAgents`（信任 agent 定义本身；调用参数白名单仍生效）；
  3. 验证式只读（见第 3 节）。
- 不豁免时维持原拦截，reason 追加指引："Read-only delegation is auto-admitted for plan-scout and verified read-only agents (single-child or static batches without host-side parameters); add trusted agents to planAdmittedAgents; script workflows require planAdmitWorkflowScripts."

### 3. 验证式只读判定 — `src/plan-scout.ts`
- 入口：`verifyReadOnlyAgent(agent, cwd, tools)`，依赖注入 `resolveContract` 与 `readAgentFile` 以便测试。
- 通过条件（全部满足）：
  1. preflight 结果 `ok`；
  2. `tools.explicitAllowlist === true`；
  3. `tools.effectiveAllowlist` 每项 ∈ 只读集合 = `{read, grep, find, ls}` ∪ `{contact_supervisor, intercom, structured_output}`（pi-subagents 协调工具）∪ 父会话 `getAllTools()` 中 `annotations.readOnlyHint === true && annotations.destructiveHint !== true` 的工具名；出现 `bash`/`powershell`/`edit`/`write`/`subagent`/`subagent_command` 或未知工具 → 不通过；
  4. `tools.configuredExtensions` 与 `tools.toolExtensionPaths` 均为空；
  5. agent 定义文件守卫：读取 `contract.agent.filePath` 的 frontmatter，顶层出现 `runner`、`machine`、`defaultAcceptance`、`acceptance`、`extensions`、`subagentOnlyExtensions`，或 `output` 为绝对路径/含 `..` → 不通过；文件不可读或非文件型（运行时注册的非 plan-scout agent）→ 不通过。
- 缓存：按 `agent@cwd` 缓存判定结果，Plan 工作流启动时清空。
- 降级：preflight 两级 import（bare `pi-subagents/preflight` → `join(getAgentDir(),"npm","node_modules","pi-subagents")` 解析 exports）均失败 → 路径 3 关闭，仅 plan-scout + 强制名单生效。

### 4. 设置 — `src/settings.ts`
- `planAdmittedAgents?: string[]`：强制放行 agent 名单（normalize 对齐 `defaultPlanTools`，`null` 清除）。
- `planAdmitWorkflowScripts?: boolean`（默认 false）：放行 `workflow: true` 脚本编排（脚本可 spawn 任意 agent 并携带宿主 gate/output，文档标注完全信任风险）。
- 设置菜单展示两项（文本消毒沿用 0.60.0 的 `sanitizeTerminalText`）。

### 5. Plan prompt — `src/prompt.ts`/`mode-contract.ts`
- `buildPlanModePrompt` 增加可选 `delegation?: { scoutRegistered: boolean }`；为真时 Phase 1 追加："For broad or parallel exploration, delegate read-only recon to the `plan-scout` subagent (single child or static `tasks` batches) without host-side options such as gate, acceptance, share, worktree, cwd, or output paths."
- 措辞变化由 fork 既有 `details.mode`/marker 兜底覆盖。

### 6. `/plan doctor`
- 诊断行：plan-scout 状态（registered / collision 含冲突来源 / unavailable+`pi install npm:pi-subagents` 建议）、验证模式（"verified via preflight" / "degraded: plan-scout + planAdmittedAgents only"）、脚本放行（planAdmitWorkflowScripts on/off）。

### 7. 依赖与版本、文档
- `package.json`：`peerDependencies` 加 `"pi-subagents": "*"`，`peerDependenciesMeta` 标 optional；版本 → **0.61.0**。
- README Features、docs/command-workflows.md 新小节（豁免形状、参数白名单与原因、验证条件、冲突处理、两项设置风险）、docs/settings.md、CHANGELOG。

## 不做的事

- 不使用 capability ceiling；不静态/预跑分析 workflow 脚本。
- 不给 plan-scout 配 bash；不豁免 external-cli/external-job/machine agent、无显式工具白名单 agent、带子扩展 agent。
- 不豁免 `capabilities` 之外的管理 action。
- 不写用户 agent 目录、不用 `PI_SUBAGENT_EXTRA_AGENT_DIRS`。
- 不改 0.60.0 吸收范围（exposure 路由等）。

## 测试与验证

**新增 standalone `test/plan-scout.test.ts`（纯函数 + 注入依赖，不依赖 monorepo support）：**
- 注册：mock 事件总线回填 → registered/dispose/幂等；无监听 → unavailable；预检发现同名 → collision 且未 emit；已注册后出现冲突 → dispose 转 collision。
- 参数白名单：`gate`、`acceptance`（非 false）、`share`、`worktree`、`isolation`、`sessionDir`、`machine`、`cwd`、字符串 `output` 任一出现 → 不豁免；`output:false`、`acceptance:false`、`async`、`model` 等 → 不影响。
- 结构：`tasks`/`chain` 合法 → 逐 agent 判定；多余键、缺 agent、单孩与多孩混用、畸形 parallel → 不豁免。
- 验证式：显式白名单只读 → 通过；`explicitAllowlist:false`（无 tools / external-cli 模拟）→ 拒；含 bash/write/subagent/未知工具 → 拒；`contact_supervisor` → 通过；MCP readOnlyHint 工具 → 通过；`configuredExtensions` 非空 → 拒；frontmatter 含 `runner`/`machine`/`defaultAcceptance`/绝对 output → 拒；文件不可读 → 拒；缓存命中。
- 强制名单：名单内 agent 通过逐 agent 判定，但参数白名单仍生效。
- 脚本：默认拒；`planAdmitWorkflowScripts:true` → 放行。
- `capabilities` → 放行；其他 action → 拒。
- 降级：resolver 不可用 → 仅路径 1/2。
- prompt：scoutRegistered 时含委托行；settings：两项解析/持久化/清除。

**monorepo 集成测试（随同步流程）：** plan-mode hook 接线顺序、拦截 reason 文案、doctor 输出。

**验证步骤：**
1. `npx tsc --noEmit`；2. `npx vitest run`（standalone 集全绿）。
3. 实机冒烟（本机 pi-subagents 0.75.0）：doctor 显示 registered + verified；Plan 中 spawn plan-scout → 放行且孩子无 bash/edit/write；`tasks:[plan-scout, evidence-auditor]` → 按工具注解判定；spawn `claude-code-writer`/`scout`/`delegate` → 拦截；plan-scout 加 `gate`、`output:"/tmp/x"`、`share:true`、`cwd` → 拦截；`workflow:true` → 默认拦截，开启 planAdmitWorkflowScripts 后放行。
4. 冲突冒烟：在项目 `.pi/agents/plan-scout.md` 放同名 agent → doctor 显示 collision、plan-scout 未注册、subagent 其他调用仍正常。
5. 降级冒烟：注入 preflight 不可用 → doctor degraded，plan-scout/强制名单仍生效。

## 假设与默认（已定）

- `cwd` 不在白名单（需要子目录探索时在 task 中写路径）；孩子 `read` 不受 srt denyRead 约束——与父会话进程内 `read` 工具现有姿态一致，不视为回归，文档注明。
- reviewer 等内置 agent 是否自动放行取决于其工具（如 `watchdog_diff`）是否带只读注解；未注解则需加入 `planAdmittedAgents`。
- 验证式信任父会话 readOnlyHint 注解（与 fork 现有 MCP 信任模型一致）；`planAdmittedAgents` 与 `planAdmitWorkflowScripts` 为用户信任声明。
- preflight 不可用时无法预检 plan-scout 冲突，接受低概率冲突并在 doctor 标注。
- 版本 0.61.0；实施顺序：先完成 0.60.0 吸收集，再本集。
- pi-subagents 版本要求：运行时注册事件协议 + `./preflight` 导出（0.75.0 满足；更老版本进入降级/unavailable 并 doctor 提示）。
