import { execFile } from "node:child_process";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import { DomainRuleError } from "../../../packages/domain/src/index.ts";

const execFileAsync = promisify(execFile);

export interface RepositoryPreflightResult {
  repositoryPath: string;
  baseBranch: string;
  initialized: boolean;
}

/**
 * Makes an empty local project usable by KanOrch without silently committing
 * files from an unknown directory.
 */
export async function ensureProjectRepository(
  repositoryPath: string,
  baseBranch: string,
): Promise<RepositoryPreflightResult> {
  if (!isAbsolute(repositoryPath)) {
    throw new DomainRuleError("repositoryPath must be an absolute local path");
  }
  await validateBranchName(baseBranch);

  const target = resolve(repositoryPath);
  await mkdir(target, { recursive: true });
  const targetStat = await stat(target);
  if (!targetStat.isDirectory()) {
    throw new DomainRuleError(`repositoryPath '${target}' must be a directory`);
  }

  const root = await tryGit(target, ["rev-parse", "--show-toplevel"]);
  if (root === null) {
    const entries = await readdir(target);
    if (entries.length > 0) {
      throw new DomainRuleError(
        `repositoryPath '${target}' is not a Git repository. Strew only auto-initializes empty directories; initialize and commit this directory manually before continuing.`,
      );
    }
    await runGit(target, ["init", "-b", baseBranch]);
    await createInitialCommit(target);
    return { repositoryPath: target, baseBranch, initialized: true };
  }

  if (!samePath(await realpath(target), await realpath(root))) {
    throw new DomainRuleError(
      `repositoryPath '${target}' must point to the Git repository root '${root}'`,
    );
  }

  const baseCommit = await tryGit(target, ["rev-parse", "--verify", `refs/heads/${baseBranch}^{commit}`]);
  if (baseCommit === null) {
    const currentCommit = await tryGit(target, ["rev-parse", "--verify", "HEAD"]);
    const currentBranch = await tryGit(target, ["symbolic-ref", "--short", "HEAD"]);
    const entries = await readdir(target);
    if (currentCommit === null && currentBranch === baseBranch && entries.length === 1 && entries[0] === ".git") {
      await createInitialCommit(target);
      return { repositoryPath: target, baseBranch, initialized: true };
    }
    throw new DomainRuleError(
      `base branch '${baseBranch}' does not exist or has no commit in repository '${target}'; an unborn repository can be initialized only when it is empty and already on that branch`,
    );
  }
  return { repositoryPath: target, baseBranch, initialized: false };
}

async function validateBranchName(baseBranch: string): Promise<void> {
  try {
    await execFileAsync("git", ["check-ref-format", "--branch", baseBranch], {
      encoding: "utf8",
      windowsHide: true,
    });
  } catch {
    throw new DomainRuleError(`base branch '${baseBranch}' is not a valid Git branch name`);
  }
}

async function createInitialCommit(repositoryPath: string): Promise<void> {
  await runGit(repositoryPath, [
    "-c",
    "user.name=KanOrch",
    "-c",
    "user.email=kanorch@local.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "Initialize project for KanOrch",
  ]);
}

async function tryGit(repositoryPath: string, args: string[]): Promise<string | null> {
  try {
    return await runGit(repositoryPath, args);
  } catch {
    return null;
  }
}

async function runGit(repositoryPath: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", repositoryPath, ...args], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const detail = gitErrorDetail(error);
    throw new DomainRuleError(
      `Git repository preparation failed for '${repositoryPath}': ${detail || "git command failed"}`,
    );
  }
}

function gitErrorDetail(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const candidate = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  for (const value of [candidate.stderr, candidate.stdout, candidate.message]) {
    if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim().slice(0, 1_000);
  }
  return "";
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right;
}
