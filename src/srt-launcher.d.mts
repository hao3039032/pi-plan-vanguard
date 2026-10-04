export function isIdentityEnvVar(name: string): boolean;
export function scrubIdentityEnv(env: Record<string, string | undefined>): string[];
export interface LauncherOptions {
  openNetwork: boolean;
  scrubEnv: boolean;
  srtPath?: string;
  settingsPath?: string;
  command?: string;
}
export function parseLauncherArgs(argv: readonly string[]): LauncherOptions;
export function resolveSandboxRuntimeLibrary(srtPath: string, realpath?: (path: string) => string): string;
