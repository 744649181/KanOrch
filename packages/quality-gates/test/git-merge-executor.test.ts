import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GitMergeError, GitMergeExecutor } from "../src/index.ts";

test("Git merge executor merges only into a clean target worktree", async () => {
  const repositoryPath = mkdtempSync(join(tmpdir(), "strew-merge-"));
  try {
    git(repositoryPath, ["init", "-b", "main"]);
    git(repositoryPath, ["config", "user.email", "strew@example.invalid"]);
    git(repositoryPath, ["config", "user.name", "Strew Test"]);
    writeFileSync(join(repositoryPath, "README.md"), "base\n", "utf8");
    git(repositoryPath, ["add", "README.md"]);
    git(repositoryPath, ["commit", "-m", "Base"]);
    git(repositoryPath, ["checkout", "-b", "strew/W-1"]);
    writeFileSync(join(repositoryPath, "feature.txt"), "merged\n", "utf8");
    git(repositoryPath, ["add", "feature.txt"]);
    git(repositoryPath, ["commit", "-m", "Feature"]);
    const expectedSourceCommit = git(repositoryPath, ["rev-parse", "HEAD"]);
    git(repositoryPath, ["checkout", "main"]);

    const executor = new GitMergeExecutor({ repositoryPath });
    await assert.rejects(executor.merge({
      workItemId: "W-1", sourceBranch: "strew/W-1", targetBranch: "main", expectedSourceCommit: "0".repeat(40),
    }), /source branch has changed/);
    const result = await executor.merge({
      workItemId: "W-1",
      sourceBranch: "strew/W-1",
      targetBranch: "main",
      expectedSourceCommit,
    });
    assert.match(result.commitSha, /^[a-f0-9]{40}$/);
    assert.equal(readFileSync(join(repositoryPath, "feature.txt"), "utf8").replace(/\r\n/g, "\n"), "merged\n");

    writeFileSync(join(repositoryPath, "dirty.txt"), "user change\n", "utf8");
    await assert.rejects(
      executor.merge({
        workItemId: "W-1",
        sourceBranch: "strew/W-1",
        targetBranch: "main",
        expectedSourceCommit,
      }),
      GitMergeError,
    );
  } finally {
    rmSync(repositoryPath, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
