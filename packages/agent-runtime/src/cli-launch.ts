import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, resolve } from "node:path";

export interface ResolvedCliLaunch {
  executable: string;
  args: string[];
}

/** Resolves Windows npm command shims without enabling shell command parsing. */
export function resolveCliLaunch(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ResolvedCliLaunch {
  const original = { executable, args: [...args] };
  if (platform !== "win32" || hasPathSegment(executable)) return original;

  const pathValue = Object.entries(environment).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  if (!pathValue) return original;
  const searchDirectories = pathValue.split(delimiter).map((entry) => entry.trim()).filter(Boolean);
  const extension = extname(executable).toLowerCase();

  for (const directory of searchDirectories) {
    const normalizedDirectory = directory.replace(/^"|"$/g, "");
    if (extension === ".exe") {
      const native = findInDirectory(normalizedDirectory, executable);
      if (native) return { executable: native, args: [...args] };
      continue;
    }
    if (!extension) {
      const native = findInDirectory(normalizedDirectory, `${executable}.exe`);
      if (native) return { executable: native, args: [...args] };
    }
    const shimName = extension === ".cmd" ? executable : `${executable}.cmd`;
    const shim = findInDirectory(normalizedDirectory, shimName);
    if (!shim) continue;
    const target = resolveNpmShimTarget(shim);
    if (!target) continue;
    if (target.endsWith(".exe")) return { executable: target, args: [...args] };
    return { executable: process.execPath, args: [target, ...args] };
  }
  return original;
}

function hasPathSegment(executable: string): boolean {
  return isAbsolute(executable) || executable.includes("/") || executable.includes("\\");
}

function findInDirectory(directory: string, name: string): string | null {
  const candidate = resolve(directory, name);
  return existsSync(candidate) ? candidate : null;
}

function resolveNpmShimTarget(shimPath: string): string | null {
  let source: string;
  try {
    source = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const targets = source.matchAll(/%dp0%[\\/]+([^"\r\n]+?\.(?:exe|[cm]?js))/gi);
  for (const match of targets) {
    const relativeTarget = match[1];
    if (!relativeTarget) continue;
    const candidate = resolve(dirname(shimPath), relativeTarget);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
