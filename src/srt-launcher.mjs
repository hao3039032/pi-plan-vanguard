#!/usr/bin/env node
// Plan-mode sandbox launcher on top of the Anthropic Sandbox Runtime (srt) library.
//
// The srt CLI only accepts an explicit domain allowlist (it rejects "*"), so this launcher drives
// srt's public `SandboxManager` API instead of the CLI:
// - the profile file is validated with srt's own `SandboxRuntimeConfigSchema`;
// - `--open-network` registers srt's ask callback approving every host. Traffic still leaves through
//   srt's proxy inside a separate network namespace, so srt's resolved-address guard keeps blocking
//   loopback, link-local, cloud-metadata, and this host's own addresses, plus the private ranges the
//   profile lists in `deniedResolvedAddresses`;
// - `--scrub-env` removes identity-bearing environment variables (tokens, keys, agent sockets)
//   before the sandboxed command inherits the environment.
// Unix sockets stay blocked by srt's seccomp filter in every mode (ssh-agent, keyrings, docker).
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AUTH_NOT_AUTHOR = /AUTH(?!OR)/u;
const IDENTITY_ENV_PATTERN = /(TOKEN|SECRET|PASSW(?:OR)?D|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|COOKIE)/iu;
const IDENTITY_ENV_NAMES = new Set([
  "GOOGLE_APPLICATION_CREDENTIALS",
  "KUBECONFIG",
  "DOCKER_CONFIG",
  "GNUPGHOME",
  "GPG_AGENT_INFO",
  "DBUS_SESSION_BUS_ADDRESS",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AZURE_CONFIG_DIR",
  "CLOUDSDK_CONFIG",
  "XAUTHORITY",
]);

/** Whether an environment variable carries (or points at) the user's identity. */
export function isIdentityEnvVar(name) {
  if (IDENTITY_ENV_NAMES.has(name.toUpperCase())) return true;
  return IDENTITY_ENV_PATTERN.test(name) || AUTH_NOT_AUTHOR.test(name.toUpperCase());
}

/** Remove identity-bearing variables from `env` in place; returns the removed names. */
export function scrubIdentityEnv(env) {
  const removed = [];
  for (const name of Object.keys(env)) {
    if (isIdentityEnvVar(name)) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

export function parseLauncherArgs(argv) {
  const options = { openNetwork: false, scrubEnv: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--open-network") options.openNetwork = true;
    else if (arg === "--scrub-env") options.scrubEnv = true;
    else if (arg === "--srt" || arg === "--settings" || arg === "-c") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      index += 1;
      if (arg === "--srt") options.srtPath = value;
      else if (arg === "--settings") options.settingsPath = value;
      else options.command = value;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!options.srtPath) throw new Error("missing --srt <path>");
  if (!options.settingsPath) throw new Error("missing --settings <path>");
  if (options.command === undefined) throw new Error("missing -c <command>");
  return options;
}

/** Locate srt's library entry next to the CLI the runtime probe found (`<pkg>/dist/cli.js` -> `dist/index.js`). */
export function resolveSandboxRuntimeLibrary(srtPath, realpath = realpathSync) {
  const cli = realpath(srtPath);
  if (basename(cli) === "cli.js" && basename(dirname(cli)) === "dist") return join(dirname(cli), "index.js");
  throw new Error(
    `cannot locate the @anthropic-ai/sandbox-runtime library next to ${srtPath} (resolved to ${cli}); install srt with npm install -g @anthropic-ai/sandbox-runtime`,
  );
}

async function main() {
  let options;
  try {
    options = parseLauncherArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`srt-launcher: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const library = await import(pathToFileURL(resolveSandboxRuntimeLibrary(options.srtPath)).href);
  const { SandboxManager, SandboxRuntimeConfigSchema } = library;
  const parsed = SandboxRuntimeConfigSchema.safeParse(JSON.parse(readFileSync(options.settingsPath, "utf8")));
  if (!parsed.success) {
    throw new Error(`invalid sandbox profile ${options.settingsPath}: ${parsed.error.message}`);
  }
  await SandboxManager.initialize(parsed.data, options.openNetwork ? async () => true : undefined);
  if (options.scrubEnv) scrubIdentityEnv(process.env);
  // Package-manager caches default to unwritable home paths; keep them in the private scratch dir.
  const scratch = process.env.CLAUDE_CODE_TMPDIR;
  if (scratch && !process.env.npm_config_cache) process.env.npm_config_cache = join(scratch, "npm-cache");
  const wrapped = await SandboxManager.wrapWithSandbox(options.command);
  const child = spawn(wrapped, { shell: true, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    SandboxManager.cleanupAfterCommand();
    if (signal) process.exit(signal === "SIGINT" || signal === "SIGTERM" ? 130 : 1);
    process.exit(code ?? 0);
  });
  child.on("error", (error) => {
    console.error(`srt-launcher: failed to execute command: ${error.message}`);
    process.exit(1);
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

const invokedDirectly = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`srt-launcher: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
