import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClineExecutionAdapter, ExecutionAdapterError } from "../src/cline-execution-adapter.ts";

test("Cline execution boundary creates, reuses, captures, and removes an isolated worktree", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "strew-cline-adapter-"));
  const repositoryPath = join(sandbox, "repository");
  const worktreeRoot = join(sandbox, "worktrees");
  try {
    git(sandbox, ["init", repositoryPath]);
    git(repositoryPath, ["config", "user.email", "strew@example.invalid"]);
    git(repositoryPath, ["config", "user.name", "Strew Test"]);
    writeFileSync(join(repositoryPath, "README.md"), "base\n", "utf8");
    git(repositoryPath, ["add", "README.md"]);
    git(repositoryPath, ["commit", "-m", "Base"]);

    const adapter = new ClineExecutionAdapter();
    const first = await adapter.ensureWorktree({
      repositoryPath,
      worktreeRoot,
      runId: "run:implementation/1",
      branchName: "strew/run-implementation-1",
    });
    assert.equal(first.reused, false);
    assert.notEqual(first.worktreePath, repositoryPath);

    const second = await adapter.ensureWorktree({
      repositoryPath,
      worktreeRoot,
      runId: "run:implementation/1",
      branchName: "strew/run-implementation-1",
    });
    assert.equal(second.reused, true);
    assert.equal(second.worktreePath, first.worktreePath);

    writeFileSync(join(first.worktreePath, "README.md"), "base\nchanged\n", "utf8");
    writeFileSync(join(first.worktreePath, "new-file.txt"), "untracked\n", "utf8");
    const changes = await adapter.captureChanges({
      worktreePath: first.worktreePath,
      baseCommit: first.baseCommit,
    });
    assert.equal(changes.isDirty, true);
    assert.deepEqual(changes.changedPaths, ["README.md", "new-file.txt"]);
    assert.match(changes.patch, /changed/);
    assert.match(changes.patch, /untracked/);
    assert.match(changes.patchSha256, /^[a-f0-9]{64}$/);

    await assert.rejects(
      adapter.removeWorktree({ repositoryPath, worktreeRoot, worktreePath: repositoryPath }),
      ExecutionAdapterError,
    );
    await adapter.removeWorktree({
      repositoryPath,
      worktreeRoot,
      worktreePath: first.worktreePath,
    });
    assert.equal(spawnSync("git", ["-C", repositoryPath, "worktree", "list", "--porcelain"], { encoding: "utf8" }).stdout.includes(first.worktreePath), false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
