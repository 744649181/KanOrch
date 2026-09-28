import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * The narrow execution boundary adapted from Cline Kanban 0.1.70 concepts.
 *
 * Strew intentionally owns none of Cline's board/card state. This adapter only
 * provides isolated Git worktrees and change capture for an AgentRun.
 */
export class ClineExecutionAdapter {
  async ensureWorktree(input: EnsureWorktreeInput): Promise<EnsuredWorktree> {
    const repositoryPath = resolve(input.repositoryPath);
    const worktreeRoot = resolve(input.worktreeRoot);
    const normalizedRunId = normalizePathSegment(input.runId);
    const worktreePath = resolve(worktreeRoot, normalizedRunId);
    assertManagedPath(worktreeRoot, worktreePath);
    if (samePath(repositoryPath, worktreePath)) {
      throw new ExecutionAdapterError("worktree path must not be the repository root");
    }

    const repositoryRoot = resolve((await runGit(repositoryPath, ["rev-parse", "--show-toplevel"])).stdout);
    if (!samePath(repositoryRoot, repositoryPath)) {
      throw new ExecutionAdapterError(
        `repositoryPath must be the Git root; expected '${repositoryRoot}' but received '${repositoryPath}'`,
      );
    }
    await runGit(repositoryPath, ["check-ref-format", "--branch", input.branchName]);
    const baseRef = input.baseRef?.trim() || "HEAD";
    const baseCommit = (await runGit(repositoryPath, ["rev-parse", "--verify", `${baseRef}^{commit}`])).stdout;

    if (await isGitWorktree(worktreePath)) {
      const currentBranch = (await runGit(worktreePath, ["branch", "--show-current"])).stdout;
      if (currentBranch !== input.branchName) {
        throw new ExecutionAdapterError(
          `existing worktree '${worktreePath}' is on '${currentBranch || "detached HEAD"}', not '${input.branchName}'`,
        );
      }
      return { worktreePath, branchName: currentBranch, baseCommit, reused: true };
    }
    if (await pathExists(worktreePath)) {
      throw new ExecutionAdapterError(`managed worktree target '${worktreePath}' exists but is not a Git worktree`);
    }

    await mkdir(worktreeRoot, { recursive: true });
    await runGit(repositoryPath, ["worktree", "prune"]);
    const branchExists = await gitSucceeds(repositoryPath, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${input.branchName}`,
    ]);
    if (branchExists) {
      await runGit(repositoryPath, ["worktree", "add", worktreePath, input.branchName]);
    } else {
      await runGit(repositoryPath, ["worktree", "add", "-b", input.branchName, worktreePath, baseCommit]);
    }
    return { worktreePath, branchName: input.branchName, baseCommit, reused: false };
  }

  async captureChanges(input: CaptureChangesInput): Promise<WorkspaceChanges> {
    const worktreePath = resolve(input.worktreePath);
    const baseCommit = (await runGit(worktreePath, ["rev-parse", "--verify", `${input.baseCommit}^{commit}`])).stdout;
    const headCommit = (await runGit(worktreePath, ["rev-parse", "--verify", "HEAD"])).stdout;
    const status = (await runGit(worktreePath, ["status", "--porcelain=v1", "-z"], false)).stdout;
    const trackedPatch = (
      await runGit(worktreePath, ["diff", "--binary", "--no-ext-diff", baseCommit, "--"], false)
    ).stdout;
    const untrackedOutput = (
      await runGit(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"], false)
    ).stdout;
    const untrackedPaths = untrackedOutput.split("\0").filter(Boolean).sort();
    const untrackedPatches: string[] = [];
    for (const path of untrackedPaths) {
      const result = await runGitWithExitCodes(
        worktreePath,
        ["diff", "--binary", "--no-index", "--", "/dev/null", path],
        [0, 1],
        false,
      );
      untrackedPatches.push(result.stdout);
    }
    const patch = `${trackedPatch}${untrackedPatches.join("")}`;
    const changedPaths = parsePorcelainPaths(status);
    return {
      baseCommit,
      headCommit,
      changedPaths,
      patch,
      patchSha256: createHash("sha256").update(patch).digest("hex"),
      isDirty: changedPaths.length > 0 || patch.length > 0,
    };
  }

  async commitAll(input: CommitWorkspaceInput): Promise<CommitWorkspaceResult> {
    const worktreePath = resolve(input.worktreePath);
    const status = (await runGit(worktreePath, ["status", "--porcelain"], false)).stdout;
    if (!status.trim()) {
      return {
        commitSha: (await runGit(worktreePath, ["rev-parse", "HEAD"])).stdout,
        committed: false,
      };
    }
    if (!input.message.trim()) throw new ExecutionAdapterError("commit message is required");
    await runGit(worktreePath, ["add", "--all"]);
    await runGit(worktreePath, ["commit", "-m", input.message.trim()]);
    return {
      commitSha: (await runGit(worktreePath, ["rev-parse", "HEAD"])).stdout,
      committed: true,
    };
  }

  async removeWorktree(input: RemoveWorktreeInput): Promise<void> {
    const repositoryPath = resolve(input.repositoryPath);
    const worktreeRoot = resolve(input.worktreeRoot);
    const worktreePath = resolve(input.worktreePath);
    assertManagedPath(worktreeRoot, worktreePath);
    if (samePath(repositoryPath, worktreePath)) {
      throw new ExecutionAdapterError("refusing to remove the repository root as a worktree");
    }
    if (!(await pathExists(worktreePath))) return;
    await runGit(repositoryPath, ["worktree", "remove", "--force", worktreePath]);
    await runGit(repositoryPath, ["worktree", "prune"]);
  }
}

export interface EnsureWorktreeInput {
  repositoryPath: string;
  worktreeRoot: string;
  runId: string;
  branchName: string;
  baseRef?: string;
}

export interface EnsuredWorktree {
  worktreePath: string;
  branchName: string;
  baseCommit: string;
  reused: boolean;
}

export interface CaptureChangesInput {
  worktreePath: string;
  baseCommit: string;
}

export interface WorkspaceChanges {
  baseCommit: string;
  headCommit: string;
  changedPaths: string[];
  patch: string;
  patchSha256: string;
  isDirty: boolean;
}

export interface CommitWorkspaceInput {
  worktreePath: string;
  message: string;
}

export interface CommitWorkspaceResult {
  commitSha: string;
  committed: boolean;
}

export interface RemoveWorktreeInput {
  repositoryPath: string;
  worktreeRoot: string;
  worktreePath: string;
}

export class ExecutionAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionAdapterError";
  }
}

function normalizePathSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (!normalized) throw new ExecutionAdapterError("runId must contain a safe path segment");
  return normalized.slice(0, 120);
}

function assertManagedPath(root: string, candidate: string): void {
  if (!isAbsolute(root) || !isAbsolute(candidate)) {
    throw new ExecutionAdapterError("managed worktree paths must be absolute");
  }
  const descendant = relative(root, candidate);
  if (!descendant || descendant === ".." || descendant.startsWith(`..\\`) || descendant.startsWith("../") || isAbsolute(descendant)) {
    throw new ExecutionAdapterError(`worktree '${candidate}' must be a descendant of managed root '${root}'`);
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isGitWorktree(path: string): Promise<boolean> {
  if (!(await pathExists(path))) return false;
  return gitSucceeds(path, ["rev-parse", "--is-inside-work-tree"]);
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await runGit(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function runGit(cwd: string, args: string[], trim = true): Promise<{ stdout: string; stderr: string }> {
  return runGitWithExitCodes(cwd, args, [0], trim);
}

function runGitWithExitCodes(
  cwd: string,
  args: string[],
  acceptedExitCodes: number[],
  trim = true,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (code !== null && acceptedExitCodes.includes(code)) {
        resolvePromise({ stdout: trim ? output.trim() : output, stderr: errorOutput.trim() });
        return;
      }
      reject(
        new ExecutionAdapterError(
          `git ${args[0] ?? "command"} failed (code=${code ?? "null"}, signal=${signal ?? "null"}): ${errorOutput.trim() || output.trim() || "no output"}`,
        ),
      );
    });
  });
}

function parsePorcelainPaths(status: string): string[] {
  if (!status) return [];
  const records = status.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (path) paths.push(path);
    if ((code.startsWith("R") || code.endsWith("R") || code.startsWith("C") || code.endsWith("C")) && records[index + 1]) {
      paths.push(records[index + 1] ?? "");
      index += 1;
    }
  }
  return [...new Set(paths.filter(Boolean))].sort();
}
