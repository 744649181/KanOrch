import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { MergeExecutor, MergeRequest, MergeResult } from "./merge-controller.ts";

export interface GitMergeExecutorOptions {
  repositoryPath: string;
  integrationWorktreeRoot?: string;
}

export class GitMergeExecutor implements MergeExecutor {
  private readonly repositoryPath: string;
  private readonly integrationWorktreeRoot: string;

  constructor(options: GitMergeExecutorOptions) {
    this.repositoryPath = resolve(options.repositoryPath);
    this.integrationWorktreeRoot = resolve(
      options.integrationWorktreeRoot ?? resolve(dirname(this.repositoryPath), ".strew-integration"),
    );
  }

  async merge(request: MergeRequest): Promise<MergeResult> {
    await runGit(this.repositoryPath, ["check-ref-format", "--branch", request.sourceBranch]);
    await runGit(this.repositoryPath, ["check-ref-format", "--branch", request.targetBranch]);
    const sourceCommit = (await runGit(this.repositoryPath, ["rev-parse", "--verify", `${request.sourceBranch}^{commit}`])).stdout;
    if (!/^[a-f0-9]{40}$/.test(request.expectedSourceCommit) || sourceCommit !== request.expectedSourceCommit) {
      throw new GitMergeError("source branch has changed since the implementation was verified");
    }
    const targetBefore = (await runGit(this.repositoryPath, ["rev-parse", "--verify", `${request.targetBranch}^{commit}`])).stdout;
    const checkedOut = await findCheckedOutBranchWorktree(this.repositoryPath, request.targetBranch);
    let mergePath = checkedOut;
    let temporary = false;
    if (!mergePath) {
      await mkdir(this.integrationWorktreeRoot, { recursive: true });
      mergePath = resolve(this.integrationWorktreeRoot, safeSegment(request.workItemId));
      await runGit(this.repositoryPath, ["worktree", "prune"]);
      await runGit(this.repositoryPath, ["worktree", "add", mergePath, request.targetBranch]);
      temporary = true;
    }
    try {
      const status = (await runGit(mergePath, ["status", "--porcelain=v1", "--untracked-files=all"], false)).stdout;
      const nonStrewChanges = status
        .split(/\r?\n/)
        .filter(Boolean)
        .filter((line) => {
          const path = line.slice(3).replaceAll("\\", "/");
          return path !== ".strew" && !path.startsWith(".strew/");
        });
      if (nonStrewChanges.length > 0) {
        throw new GitMergeError(`target worktree '${mergePath}' is not clean; automatic merge is not allowed`);
      }
      try {
        await runGit(mergePath, ["merge", "--no-edit", request.expectedSourceCommit]);
      } catch (error) {
        await runGit(mergePath, ["merge", "--abort"]).catch(() => undefined);
        throw new GitMergeError(`Git merge failed and was aborted: ${errorMessage(error)}`);
      }
      const commitSha = (await runGit(mergePath, ["rev-parse", "HEAD"])).stdout;
      return {
        commitSha,
        summary: `${request.sourceBranch} merged into ${request.targetBranch} (${targetBefore.slice(0, 12)} -> ${commitSha.slice(0, 12)})`,
      };
    } finally {
      if (temporary && mergePath) {
        await runGit(this.repositoryPath, ["worktree", "remove", "--force", mergePath]).catch(() => undefined);
        await runGit(this.repositoryPath, ["worktree", "prune"]).catch(() => undefined);
      }
    }
  }
}

export class GitMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitMergeError";
  }
}

async function findCheckedOutBranchWorktree(repositoryPath: string, branchName: string): Promise<string | null> {
  const output = (await runGit(repositoryPath, ["worktree", "list", "--porcelain"], false)).stdout;
  let worktree: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) worktree = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branchName}`) return worktree ? resolve(worktree) : null;
    if (!line && worktree) worktree = null;
  }
  return null;
}

function safeSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (!normalized) throw new GitMergeError("workItemId is not safe for an integration worktree path");
  return normalized.slice(0, 120);
}

function runGit(cwd: string, args: string[], trim = true): Promise<{ stdout: string; stderr: string }> {
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
      if (code === 0) {
        resolvePromise({ stdout: trim ? output.trim() : output, stderr: errorOutput.trim() });
        return;
      }
      reject(new GitMergeError(`git ${args[0] ?? "command"} failed (code=${code ?? "null"}, signal=${signal ?? "null"}): ${errorOutput.trim() || output.trim() || "no output"}`));
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
