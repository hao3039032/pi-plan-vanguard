import assert from "node:assert/strict";
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

test("resolveSandboxRuntimeLibrary finds dist/index.js next to the real srt CLI", () => {
  const realpath = (path: string) => (path === "/usr/bin/srt" ? "/lib/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js" : path);
  assert.equal(resolveSandboxRuntimeLibrary("/usr/bin/srt", realpath), "/lib/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js");
  assert.throws(() => resolveSandboxRuntimeLibrary("/opt/srt-wrapper", (path: string) => path), /cannot locate/u);
});
