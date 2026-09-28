import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteEventStore } from "../../event-store/src/index.ts";
import { ProjectRepository } from "../src/index.ts";

test("project state reopens from a transactional projection", () => {
  const directory = mkdtempSync(join(tmpdir(), "strew-project-repository-"));
  const databasePath = join(directory, "strew.db");
  try {
    const firstStore = new SqliteEventStore(databasePath);
    const first = new ProjectRepository(firstStore);
    const created = first.createProject(
      {
        projectId: "p-1",
        name: "Strew",
        repositoryPath: directory,
        goal: "Direct multiple coding agents",
      },
      { expectedRevision: 0, idempotencyKey: "create-p-1", actorType: "user", actorId: "owner" },
    );
    const added = first.addWorkItem(
      "p-1",
      {
        workItemId: "S-1",
        kind: "task",
        title: "Implement event store",
        description: "Persist ordered project events",
        acceptanceCriteria: ["State reopens after process restart"],
        requiredCapabilities: ["typescript"],
        allowedRoles: ["implementation"],
      },
      {
        expectedRevision: created.revision,
        idempotencyKey: "add-s-1",
        actorType: "system",
        actorId: "director",
      },
    );
    assert.equal(added.revision, 2);
    firstStore.close();

    const reopenedStore = new SqliteEventStore(databasePath);
    const reopened = new ProjectRepository(reopenedStore).load("p-1");
    assert.equal(reopened.revision, 2);
    assert.equal(reopened.state.project?.name, "Strew");
    assert.equal(reopened.state.workItems["S-1"]?.title, "Implement event store");
    assert.equal(reopenedStore.readStream("project:p-1").length, 2);
    reopenedStore.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("repository preserves command idempotency through the projection boundary", () => {
  const store = new SqliteEventStore(":memory:");
  const repository = new ProjectRepository(store);
  const input = {
    projectId: "p-1",
    name: "Strew",
    repositoryPath: "C:/workspace/strew",
    goal: "Direct multiple coding agents",
    createdAt: "2026-08-24T00:00:00.000Z",
  };
  const context = {
    expectedRevision: 0,
    idempotencyKey: "create-p-1",
    actorType: "user" as const,
    actorId: "owner",
  };
  const first = repository.createProject(input, context);
  const replay = repository.createProject(input, context);
  assert.equal(replay.revision, first.revision);
  assert.equal(store.readAll().length, 1);
  store.close();
});
