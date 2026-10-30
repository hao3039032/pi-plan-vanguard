import type { ToolInfo, ToolExposure } from "@earendil-works/pi-coding-agent";

/**
 * Standalone tool-info builders mirroring the monorepo's `nativeTool` helpers, so
 * exposure-aware tests run without the monorepo support harness.
 */

export interface NativeToolOptions {
  name?: string;
  description?: string;
  source?: string;
  path?: string;
  scope?: ToolInfo["sourceInfo"]["scope"];
  exposure?: ToolExposure;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export function nativeTool(options: NativeToolOptions = {}): ToolInfo {
  const name = options.name ?? "native_tool";
  const source = options.source ?? "extension";
  const path = options.path ?? "/extensions/demo/extension.ts";
  return {
    name,
    description: options.description ?? "Native tool description",
    parameters: {} as ToolInfo["parameters"],
    exposure: options.exposure ?? "direct",
    ...(options.readOnlyHint === undefined && options.destructiveHint === undefined
      ? {}
      : {
          annotations: {
            ...(options.readOnlyHint !== undefined ? { readOnlyHint: options.readOnlyHint } : {}),
            ...(options.destructiveHint !== undefined ? { destructiveHint: options.destructiveHint } : {}),
          },
        }),
    sourceInfo: {
      source,
      path: options.path === undefined && source === "builtin" ? `builtin:${name}` : path,
      scope: options.scope ?? "user",
      origin: "package",
    },
  };
}

export function builtinTool(name: string, options: NativeToolOptions = {}): ToolInfo {
  return nativeTool({ name, source: "builtin", path: `builtin:${name}`, ...options });
}

export function builtinExtensionTool(name: string, options: NativeToolOptions = {}): ToolInfo {
  // Tools from Pi's built-in extensions (mcp, codemode, ...) carry the extension's path.
  return nativeTool({ name, source: "builtin", path: "builtin:mcp", ...options });
}

export function builtinExtensionEntryTool(name: string, options: NativeToolOptions = {}): ToolInfo {
  // An entry tool named after its built-in extension (codemode at builtin:codemode, mcp at
  // builtin:mcp) carries a path that looks exactly like a core built-in's `builtin:<name>`.
  return nativeTool({ name, source: "builtin", path: `builtin:${name}`, ...options });
}

/** Pi 1.4's entry definition is model-only and registered defaultActive: false (not in ToolInfo). */
export function builtinCodemodeTool(): ToolInfo {
  return builtinExtensionEntryTool("codemode", { exposure: "model-only" });
}

export function extensionTool(name: string, options: NativeToolOptions = {}): ToolInfo {
  return nativeTool({ name, source: "extension", ...options });
}
