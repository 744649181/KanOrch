import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { LocalArtifactStore } from "../src/index.ts";

test("local artifact store writes content atomically and verifies its hash", async () => {
  const repositoryPath = mkdtempSync(join(tmpdir(), "strew-artifacts-"));
  try {
    const store = new LocalArtifactStore(repositoryPath);
    const artifact = await store.write({
      artifactId: "log-1",
      projectId: "project-1",
      workItemId: "work-1",
      runId: "run-1",
      kind: "log",
      content: "ordered log\n",
      mediaType: "text/plain",
      extension: "log",
    });
    assert.match(artifact.relativePath, /^\.strew\/artifacts\//);
    assert.match(artifact.contentHash, /^[a-f0-9]{64}$/);
    assert.equal((await store.read(artifact)).toString("utf8"), "ordered log\n");

    const replay = await store.write({
      artifactId: "log-1",
      projectId: "project-1",
      workItemId: "work-1",
      runId: "run-1",
      kind: "log",
      content: "ordered log\n",
      mediaType: "text/plain",
      extension: "log",
    });
    assert.equal(replay.relativePath, artifact.relativePath);
  } finally {
    rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("artifacts do not dirty a Git repository or replace its local exclusions", async () => {
  const repositoryPath = mkdtempSync(join(tmpdir(), "strew-artifacts-git-"));
  try {
    assert.equal(spawnSync("git", ["init", "-b", "main"], { cwd: repositoryPath, windowsHide: true }).status, 0);
    const excludePath = join(repositoryPath, ".git", "info", "exclude");
    const original = readFileSync(excludePath, "utf8");
    await new LocalArtifactStore(repositoryPath).write({
      projectId: "project-1", workItemId: "work-1", runId: "run-1", kind: "log",
      content: "run log", mediaType: "text/plain",
    });
    assert.ok(readFileSync(excludePath, "utf8").startsWith(original));
    assert.match(readFileSync(excludePath, "utf8"), /^\/\.strew\/$/m);
    assert.equal(spawnSync("git", ["status", "--porcelain"], {
      cwd: repositoryPath, windowsHide: true, encoding: "utf8",
    }).stdout, "");
  } finally {
    rmSync(repositoryPath, { recursive: true, force: true });
  }
});
