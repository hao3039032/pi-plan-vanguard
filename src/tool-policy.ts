import type { ToolInfo } from "@earendil-works/pi-coding-agent";

// Plan-mode exploration is enforced by the Anthropic Sandbox Runtime (SRT) OS sandbox: the bash
// tool runs every command inside a sandboxed process tree, so no command-text allowlist applies.
// PowerShell is blocked in v1 because the SRT wrap covers the bash tool only.
export const SAFE_BUILTIN_PLAN_TOOLS = new Set(["read", "bash", "grep", "find", "ls"]);
export type PlanModeToolPolicy = "read-only" | "sandboxed" | "user-opt-in" | "blocked";

// edit/write stay unselectable for the Plan policy; the tool_call hook admits the built-in
// versions only for targets inside the plan output directory (see isPlanOutputWriteToolName).
const BLOCKED_BUILTIN_TOOLS = new Set(["edit", "write", "powershell"]);
const PLAN_OUTPUT_WRITE_TOOLS = new Set(["edit", "write"]);

// Pi ships its eight classic tools (read/bash/edit/write/grep/find/ls/powershell) as core
// built-ins with the synthetic path `builtin:<name>` (older Pi: no path). Tools from Pi's
// built-in extensions (codemode, mcp, tool-search) carry the extension's path, e.g. `builtin:mcp`,
// so they take the annotation path below like any other extension or MCP tool.
// Name collision: an extension's entry tool can be named after its extension (the codemode
// extension registers a `codemode` tool at `builtin:codemode`), which is indistinguishable from
// a core built-in by shape alone. Those extension names are excluded from the core-tool pattern.
const BUILTIN_EXTENSION_NAMES = new Set(["codemode", "mcp", "tool-search"]);

export function isBuiltinTool(tool: ToolInfo) {
  if (tool.sourceInfo?.source !== "builtin") return false;
  if (tool.exposure === "model-only") return false;
  const path = tool.sourceInfo?.path;
  if (!path) return true;
  if (path !== `builtin:${tool.name}`) return false;
  return !BUILTIN_EXTENSION_NAMES.has(tool.name);
}

/** Path of Pi's built-in codemode extension; its entry tool carries this extension path. */
const BUILTIN_CODEMODE_EXTENSION_PATH = "builtin:codemode";

/**
 * Pi's built-in codemode entry tool: scripts run inside a QuickJS sandbox with no host access of
 * their own, and every tool effect flows through nested calls that this policy checks on their
 * own (bash stays SRT-wrapped, edit/write stay blocked outside the plan output directory), so the
 * orchestrator itself is auto-admitted instead of requiring an explicit opt-in.
 */
export function isBuiltinCodemodeTool(tool: ToolInfo) {
  return (
    tool.sourceInfo?.source === "builtin" && tool.sourceInfo?.path === BUILTIN_CODEMODE_EXTENSION_PATH
  );
}

export function classifyPlanModeTool(tool: ToolInfo): PlanModeToolPolicy {
  if (!tool.sourceInfo?.source) return "blocked";
  if (!isBuiltinTool(tool)) {
    // Extension and MCP tools run in-process, outside the sandbox. Trust their declared
    // read-only hint: a read-only tool cannot destroy anything, so it needs no opt-in.
    if (tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true) {
      return "read-only";
    }
    // The built-in codemode entry tool only orchestrates individually policy-checked nested
    // calls from its JS sandbox, so it is admitted like the sandboxed shell, not gated on opt-in.
    if (isBuiltinCodemodeTool(tool)) return "sandboxed";
    return "user-opt-in";
  }
  if (BLOCKED_BUILTIN_TOOLS.has(tool.name)) return "blocked";
  if (tool.name === "bash") return "sandboxed";
  return SAFE_BUILTIN_PLAN_TOOLS.has(tool.name) ? "read-only" : "blocked";
}

/** Tools that cannot break anything and are therefore admitted without explicit selection. */
export function isAutoAdmittedPlanTool(tool: ToolInfo) {
  const policy = classifyPlanModeTool(tool);
  return policy === "read-only" || policy === "sandboxed";
}

export function canSelectToolInPlanMode(tool: ToolInfo) {
  return classifyPlanModeTool(tool) !== "blocked";
}

/** Built-in tool names that may write inside the plan output directory during Plan mode. */
export function isPlanOutputWriteToolName(name: string) {
  return PLAN_OUTPUT_WRITE_TOOLS.has(name);
}

/** The `path` argument of the built-in write/edit tools (WriteToolInput / EditToolInput). */
export function readToolPath(input: unknown) {
  const candidate = input as { path?: unknown } | undefined;
  return typeof candidate?.path === "string" ? candidate.path : undefined;
}

export function readCommand(input: unknown) {
  const command = input as { command?: unknown } | undefined;
  return typeof command?.command === "string" ? command.command : "";
}

export function powershellBlockReason() {
  return "Plan mode runs shell commands through the SRT OS sandbox, which covers the bash tool only in this release. Use bash for exploration; PowerShell sandboxing arrives with srt-win support.";
}
