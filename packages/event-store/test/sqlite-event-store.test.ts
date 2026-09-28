import assert from "node:assert/strict";
import test from "node:test";

import {
  IdempotencyConflictError,
  RevisionConflictError,
  SqliteEventStore,
} from "../src/index.ts";

function projectCreated(name = "Strew") {
  return {
    eventId: "event-project-created",
    eventType: "project.created" as const,
    actorType: "user" as const,
    actorId: "owner",
    createdAt: "2026-08-24T00:00:00.000Z",
    payload: {
      project: {
        projectId: "p-1",
        name,
        repositoryPath: "C:/workspace/strew",
        goal: "Build an agent director",
        policy: {
          maxDecompositionDepth: 4,
          maxAgentDelegationDepth: 2,
          maxAttemptsPerStage: 3,
          maxReplanDepth: 2,
          requireIndependentReview: true,
          autoMerge: true,
        },
        createdAt: "2026-08-24T00:00:00.000Z",
      },
    },
  };
}

test("append is transactional and returns ordered revisions", () => {
  const store = new SqliteEventStore(":memory:");
  const events = store.append({
    streamId: "project:p-1",
    streamType: "project",
    expectedRevision: 0,
    idempotencyKey: "create-project",
    events: [projectCreated()],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.revision, 1);
  assert.equal(events[0]?.sequence, 1);
  assert.equal(store.currentRevision("project:p-1"), 1);
  store.close();
});
test("replaying the same command is idempotent", () => {
  const store = new SqliteEventStore(":memory:");
  const command = {
    streamId: "project:p-1",
    streamType: "project",
    expectedRevision: 0,
    idempotencyKey: "create-project",
    events: [projectCreated()],
  };
  const first = store.append(command);
  const replay = store.append(command);
  assert.deepEqual(replay, first);
  assert.equal(store.readAll().length, 1);
  store.close();
});

test("idempotency keys cannot hide a different command", () => {
  const store = new SqliteEventStore(":memory:");
  store.append({
    streamId: "project:p-1",
    streamType: "project",
    expectedRevision: 0,
    idempotencyKey: "create-project",
    events: [projectCreated()],
  });
  assert.throws(
    () =>
      store.append({
        streamId: "project:p-1",
        streamType: "project",
        expectedRevision: 0,
        idempotencyKey: "create-project",
        events: [projectCreated("Different")],
      }),
    IdempotencyConflictError,
  );
  store.close();
});

test("stale expected revisions are rejected without partial writes", () => {
  const store = new SqliteEventStore(":memory:");
  store.append({
    streamId: "project:p-1",
    streamType: "project",
    expectedRevision: 0,
    idempotencyKey: "create-project",
    events: [projectCreated()],
  });
  assert.throws(
    () =>
      store.append({
        streamId: "project:p-1",
        streamType: "project",
        expectedRevision: 0,
        idempotencyKey: "stale-command",
        events: [
          {
            eventType: "work_item.status_changed",
            actorType: "system",
            payload: { workItemId: "S-1", status: "ready" },
          },
        ],
      }),
    RevisionConflictError,
  );
  assert.equal(store.readAll().length, 1);
  store.close();
});

test("a failed batch rolls back events and command receipt", () => {
  const store = new SqliteEventStore(":memory:");
  const duplicateEventId = "same-event";
  assert.throws(() =>
    store.append({
      streamId: "project:p-1",
      streamType: "project",
      expectedRevision: 0,
      idempotencyKey: "invalid-batch",
      events: [
        { ...projectCreated(), eventId: duplicateEventId },
        {
          eventId: duplicateEventId,
          eventType: "work_item.status_changed",
          actorType: "system",
          payload: { workItemId: "S-1", status: "ready" },
        },
      ],
    }),
  );
  assert.equal(store.readAll().length, 0);
  assert.equal(store.currentRevision("project:p-1"), 0);
  store.close();
});
