import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { buildPlanModePrompt } from "../src/prompt.js";
import planMode, { createMockContext, createMockPi, TEST_CWD } from "./support.js";
import { builtinCodemodeTool, builtinTool, extensionTool } from "./tool-exposure-support.js";

type ToolCallResult = { block?: boolean; reason?: string } | undefined;

async function startPlan(options: { activeCodemode?: boolean; configured?: string[] } = {}) {
  const mock = createMockPi({
    // Pi registers codemode defaultActive: false; registration alone must not enable it.
    activeTools: ["read", "bash", "edit", "write", "external_write", ...(options.activeCodemode ? ["codemode"] : [])],
    allTools: [
      builtinCodemodeTool(),
      ...["read", "bash", "edit", "write"].map((name) => builtinTool(name)),
      extensionTool("external_write", { exposure: "codemode" }),
    ],
  });
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: {
        thinkingLevel: "inherit" as const,
        ...(options.configured === undefined ? {} : { defaultPlanTools: options.configured }),
      },
    }),
  });
  const context = createMockContext();
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  await mock.events.get("context")?.[0]?.({ messages: [] }, context.ctx);
  let nextId = 0;
  const call = async (toolName: string, input: unknown = {}, parentToolCallId?: string) =>
    (await mock.events.get("tool_call")?.[0]?.(
      { toolName, input, toolCallId: `call-${++nextId}`, ...(parentToolCallId ? { parentToolCallId } : {}) },
      context.ctx,
    )) as ToolCallResult;
  const policy = () => {
    const state = mock.entries.filter((entry) => entry.customType === "plan-mode-state").at(-1)?.data as
      | { workflowToolPolicy?: { allowedNames: string[]; resolved: boolean } }
      | undefined;
    return state?.workflowToolPolicy;
  };
  return { mock, context, call, policy };
}

test("active model-only codemode is frozen into automatic Plan policy with its full capability", async () => {
  const plan = await startPlan({ activeCodemode: true });
  assert.equal(plan.policy()?.resolved, true);
  assert.ok(plan.policy()?.allowedNames.includes("codemode"));
  // Admission intentionally does not parse or restrict models.*. No provider request is executed
  // by this hook-level test; Pi owns that bridge, outside nested tool_call checks.
  assert.equal(await plan.call("codemode", { code: 'return await models.generateImages({provider:"test",id:"image"}, {input:[]});' }), undefined);
  assert.equal((await plan.call("codemode", { code: "return 1" }, "outer-tool"))?.block, true);
});

test("codemode default admission never activates it and late activation persists admission", async () => {
  const plan = await startPlan();
  assert.ok(!plan.mock.rawPi.getActiveTools().includes("codemode"));
  assert.ok(!plan.policy()?.allowedNames.includes("codemode"));
  const inactive = await plan.call("codemode", { code: "return 1" });
  assert.equal(inactive?.block, true);
  assert.match(inactive?.reason ?? "", /inactive/u);
  assert.ok(!plan.policy()?.allowedNames.includes("codemode"));

  plan.mock.rawPi.setActiveTools([...plan.mock.rawPi.getActiveTools(), "codemode"]);
  assert.equal(await plan.call("codemode", { code: "return 1" }), undefined);
  assert.ok(plan.policy()?.allowedNames.includes("codemode"));
  const nested = await plan.call("codemode", { code: "return 1" }, "outer-tool");
  assert.equal(nested?.block, true);
  assert.match(nested?.reason ?? "", /only be called by the model directly, not by other tools/u);
});

test("explicit empty Plan selection still admits full codemode but not its unselected nested tools", async () => {
  const plan = await startPlan({ activeCodemode: true, configured: [] });
  assert.deepEqual(plan.policy()?.allowedNames, []);
  assert.equal(await plan.call("codemode", { code: "return 1" }), undefined);
  assert.ok(plan.policy()?.allowedNames.includes("codemode"));

  // Model the parentToolCallId that Pi attaches to tools.* calls. Admission of the parent is not
  // transitive: every nested call is checked independently by the extension's real tool_call hook.
  assert.equal(await plan.call("read", { path: "README.md" }, "codemode-parent"), undefined);
  for (const toolName of ["edit", "write"]) {
    const result = await plan.call(toolName, { path: join(TEST_CWD, "src", "outside-plan.ts") }, "codemode-parent");
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /mutating tool/u);
  }
  const unselected = await plan.call("external_write", {}, "codemode-parent");
  assert.equal(unselected?.block, true);
  assert.match(unselected?.reason ?? "", /not selected/u);

  const bashInput = { command: "git status --short" };
  assert.equal(await plan.call("bash", bashInput, "codemode-parent"), undefined);
  assert.match(bashInput.command, /srt-launcher\.mjs/u);
  assert.match(bashInput.command, /'--settings' '[^']+'/u);
  assert.match(bashInput.command, /'--scrub-env' '-c' 'git status --short'$/u);
  assert.equal((await plan.call("codemode", { code: "return 1" }, "codemode-parent"))?.block, true);
});

test("Plan contract discloses full codemode credential, cost and persistence capabilities", () => {
  const prompt = buildPlanModePrompt();
  assert.match(prompt, /Default admission does not activate tools/u);
  assert.match(prompt, /models\.classify\/models\.generateImages/u);
  assert.match(prompt, /session's credentials/u);
  assert.match(prompt, /incur costs/u);
  assert.match(prompt, /not checked by the nested-tool policy or SRT/u);
  assert.match(prompt, /store\(\) persists session state/u);
  assert.match(prompt, /host-managed temporary files/u);
  assert.match(prompt, /bash remains SRT-wrapped/u);
});

for (const credentialHardening of [true, false]) {
  test(`sandboxed Plan contract scopes identity restrictions to shell with credential hardening ${credentialHardening}`, () => {
    const prompt = buildPlanModePrompt({
      writePaths: [join(TEST_CWD, "plans")],
      planOutputDir: join(TEST_CWD, "plans"),
      allowedDomains: [],
      network: "open",
      credentialHardening,
    });
    assert.match(prompt, /## Sandboxed exploration/u);
    assert.match(prompt, /Identity \(sandboxed shell commands\)/u);
    assert.match(prompt, /(?:Shell commands must|and must) use the network only anonymously/u);
    assert.match(prompt, /(?:never|do not) log in, authenticate, or act as the user/u);
    assert.match(prompt, /never change remote state \(no pushes, publishes, issue\/PR\/comment creation, or other mutating requests\)/u);
    assert.match(prompt, /These shell-only identity restrictions do not restrict the permitted codemode model-provider bridge/u);
    assert.match(prompt, /still apply to every shell call, including tools\.bash from codemode/u);
    assert.match(prompt, /models\.classify\/models\.generateImages bridge instead calls providers directly with the session's credentials/u);
    assert.match(prompt, /may transmit data and incur costs, and is not checked by the nested-tool policy or SRT/u);
    assert.match(prompt, /These full built-in codemode capabilities are allowed by the Plan product policy/u);
    if (credentialHardening) {
      assert.match(prompt, /credentials are not available in the sandbox/u);
      assert.match(prompt, /credential stores are unreadable and token variables are removed/u);
      assert.doesNotMatch(prompt, /credential hardening is OFF/u);
    } else {
      assert.match(prompt, /credential hardening is OFF, so the user's credentials may be reachable/u);
      assert.match(prompt, /Shell commands must still never use them/u);
    }
  });
}
