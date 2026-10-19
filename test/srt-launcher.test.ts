import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  isIdentityEnvVar,
  parseLauncherArgs,
  resolveSandboxRuntimeLibrary,
  scrubIdentityEnv,
} from "../src/srt-launcher.mjs";

test("identity env vars are recognized without touching ordinary variables", () => {
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "SSH_AUTH_SOCK",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "KUBECONFIG",
    "DOCKER_CONFIG",
    "DB_PASSWORD",
    "npm_config__auth",
    "XAUTHORITY",
  ]) {
    assert.equal(isIdentityEnvVar(name), true, name);
  }
  for (const name of ["PATH", "HOME", "LANG", "TERM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "TMPDIR", "SHELL", "NODE_OPTIONS"]) {
    assert.equal(isIdentityEnvVar(name), false, name);
  }
});

test("scrubIdentityEnv removes identity variables in place", () => {
  const env: Record<string, string> = { PATH: "/bin", GH_TOKEN: "x", OPENAI_API_KEY: "y", GIT_AUTHOR_NAME: "me" };
  assert.deepEqual(scrubIdentityEnv(env).sort(), ["GH_TOKEN", "OPENAI_API_KEY"]);
  assert.deepEqual(env, { PATH: "/bin", GIT_AUTHOR_NAME: "me" });
});

test("parseLauncherArgs requires srt, settings, and a command", () => {
  assert.deepEqual(parseLauncherArgs(["--srt", "/s", "--settings", "/p.json", "--open-network", "--scrub-env", "-c", "ls"]), {
    openNetwork: true,
    scrubEnv: true,
    srtPath: "/s",
    settingsPath: "/p.json",
    command: "ls",
  });
  assert.deepEqual(parseLauncherArgs(["--srt", "/s", "--settings", "/p.json", "-c", ""]).command, "");
  assert.throws(() => parseLauncherArgs(["--settings", "/p.json", "-c", "ls"]), /--srt/u);
  assert.throws(() => parseLauncherArgs(["--srt", "/s", "-c", "ls"]), /--settings/u);
  assert.throws(() => parseLauncherArgs(["--srt", "/s", "--settings", "/p.json"]), /-c/u);
  assert.throws(() => parseLauncherArgs(["--srt", "/s", "--settings", "/p.json", "--bogus", "-c", "ls"]), /unknown/u);
  assert.throws(() => parseLauncherArgs(["--srt"]), /missing value/u);
});

function withRuntimeFixture(run: (root: string, packageDir: string, entry: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "pi-plan-mode-srt-shim-"));
  const packageDir = join(root, "node_modules", "@anthropic-ai", "sandbox-runtime");
  try {
    mkdirSync(join(packageDir, "dist"), { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@anthropic-ai/sandbox-runtime", type: "module" }));
    writeFileSync(join(packageDir, "dist", "cli.js"), "");
    writeFileSync(join(packageDir, "dist", "index.js"), "export const SandboxManager = {};\n");
    // Expose realpath-canonicalized paths because the implementation returns them with macOS's
    // /var -> /private/var and Windows 8.3 short TEMP prefixes already rewritten.
    const canonicalPackageDir = realpathSync(packageDir);
    run(root, canonicalPackageDir, join(canonicalPackageDir, "dist", "index.js"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("resolveSandboxRuntimeLibrary handles direct CLI paths and POSIX symlink targets", () => {
  withRuntimeFixture((root, packageDir, entry) => {
    const cli = join(packageDir, "dist", "cli.js");
    assert.equal(resolveSandboxRuntimeLibrary(cli), entry);
    // Simulate realpath's symlink resolution without requiring Windows symlink privileges.
    assert.equal(resolveSandboxRuntimeLibrary(join(root, "bin", "srt"), () => cli), entry);
  });
});

test("resolveSandboxRuntimeLibrary handles global and local npm shims without executing them", () => {
  withRuntimeFixture((root, _packageDir, entry) => {
    const binDir = join(root, "node_modules", ".bin");
    mkdirSync(binDir);
    for (const directory of [root, binDir]) {
      for (const name of ["srt.cmd", "SRT.CMD", "srt.ps1", "srt"]) {
        const shim = join(directory, name);
        writeFileSync(shim, "this shim must never execute");
        assert.equal(resolveSandboxRuntimeLibrary(shim), entry);
      }
    }
  });
});

test("resolveSandboxRuntimeLibrary rejects missing, malformed, and unrelated packages", () => {
  withRuntimeFixture((root, packageDir) => {
    const shim = join(root, "srt.cmd");
    writeFileSync(shim, "");
    const manifest = join(packageDir, "package.json");
    for (const contents of ["{", "null", JSON.stringify({ name: "unrelated-package" })]) {
      writeFileSync(manifest, contents);
      assert.throws(() => resolveSandboxRuntimeLibrary(shim), /cannot locate.*package\.json/u);
    }
    rmSync(manifest);
    assert.throws(() => resolveSandboxRuntimeLibrary(shim), /cannot locate/u);
  });
});

test("resolveSandboxRuntimeLibrary requires a library file and never falls back to another install", () => {
  withRuntimeFixture((root, packageDir, entry) => {
    const shim = join(root, "srt.cmd");
    writeFileSync(shim, "");
    rmSync(entry);
    assert.throws(() => resolveSandboxRuntimeLibrary(shim), /dist\/index\.js/u);
    assert.throws(() => resolveSandboxRuntimeLibrary(join(packageDir, "dist", "cli.js")), /cannot locate/u);
    mkdirSync(entry);
    assert.throws(() => resolveSandboxRuntimeLibrary(shim), /cannot locate/u);
    rmSync(packageDir, { recursive: true });
    assert.throws(() => resolveSandboxRuntimeLibrary(shim), /cannot locate/u);
  });
});

test(
  "the launcher loads a Windows shim's library and still fails when sandbox initialization fails",
  () => {
    withRuntimeFixture((root, _packageDir, entry) => {
      const shim = join(root, "srt.cmd");
      const profile = join(root, "profile.json");
      writeFileSync(shim, "this shim must never execute");
      writeFileSync(profile, "{}");
      writeFileSync(entry, `
        export const SandboxRuntimeConfigSchema = { safeParse: data => ({ success: true, data }) };
        export const SandboxManager = {
          initialize: async () => { throw new Error("fixture sandbox initialization denied"); },
          wrapWithSandbox: () => { throw new Error("must not run after failed initialization"); }
        };
      `);
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL("../src/srt-launcher.mjs", import.meta.url)),
        "--srt", shim, "--settings", profile, "-c", "exit 0",
      ], { encoding: "utf8", timeout: 5_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /fixture sandbox initialization denied/u);
      assert.doesNotMatch(result.stderr, /cannot locate|must not run after/u);
    });
  },
  // The child keeps its own 5 s spawnSync budget; the 10 s policy cap leaves cold-start margin.
  10_000,
);

test("resolveSandboxRuntimeLibrary rejects unknown wrappers even beside a valid package", () => {
  withRuntimeFixture((root) => {
    const wrapper = join(root, "custom-wrapper.cmd");
    writeFileSync(wrapper, "");
    assert.throws(() => resolveSandboxRuntimeLibrary(wrapper), /cannot locate/u);
  });
});
