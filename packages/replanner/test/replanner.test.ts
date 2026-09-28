import assert from "node:assert/strict";
import test from "node:test";

import type { PersistedRunEvent } from "../../agent-protocol/src/index.ts";
import {
  decideAddDependency,
  decideAddWorkItem,
  decideChangeWorkItemStatus,
  decideCreateProject,
  decideFinishAgentRun,
  decideRecordBudgetEntry,
  decideRegisterAgent,
  decideResolveDecision,
  decideStartAgentRun,
  emptyProjectState,
  evolveProject,
  type ProjectState,
} from "../../domain/src/index.ts";
import { decisionPauseEvents, expandAffectedSubgraph, Replanner } from "../src/index.ts";

test("replanner detects retry, permission, and budget triggers and produces complete decisions that pause the affected DAG", () => {
  let state = buildState();
  for (const attempt of [1, 2]) {
    state = evolveProject(state, decideChangeWorkItemStatus(state, "W-1", "ready"));
    state = evolveAll(
      state,
      decideStartAgentRun(state, {
        runId: `run-${attempt}`,
        workItemId: "W-1",
        agentId: "codex",
        role: "implementation",
        attempt,
        delegationDepth: 0,
        worktreePath: `C:/worktrees/run-${attempt}`,
        branchName: `strew/run-${attempt}`,
      }),
    );
    state = evolveAll(state, decideFinishAgentRun(state, `run-${attempt}`, "failed"));
  }
  state = evolveProject(
    state,
    decideRecordBudgetEntry(state, {
      budgetEntryId: "budget-2",
      projectId: "p-1",
      workItemId: "W-1",
      runId: "run-2",
      kind: "actual",
      inputTokens: 11,
      outputTokens: 0,
      costUsd: 0,
      wallClockSeconds: 1,
      createdAt: new Date().toISOString(),
    }),
  );

  const replanner = new Replanner();
  const signals = replanner.detectAutomatic(state, {
    workItemId: "W-1",
    runId: "run-2",
    runEvents: [approvalEvent("run-2")],
  });
  assert.deepEqual(signals.map((signal) => signal.trigger).sort(), [
    "budget_exceeded",
    "permission_escalation",
    "retry_exhausted",
  ]);
  assert.deepEqual(expandAffectedSubgraph(state, ["W-1"]), ["W-1", "W-2"]);

  const decision = replanner.buildDecision(state, signals.find((signal) => signal.trigger === "retry_exhausted")!);
  assert.equal(decision.objective, "Ship safely");
  assert.equal(decision.options.length, 3);
  assert.equal(decision.logicStack.length > 0, true);
  assert.equal(decision.attempts.length, 2);
  assert.deepEqual(decision.affectedWorkItemIds, ["W-1", "W-2"]);
  assert.equal(decision.options.some((option) => option.optionId === decision.recommendedOptionId), true);

  state = decisionPauseEvents(state, decision).reduce(evolveProject, state);
  assert.equal(state.workItems["W-1"]?.ownStatus, "blocked");
  assert.equal(state.workItems["W-2"]?.ownStatus, "blocked");
  assert.equal(state.decisions[decision.decisionId]?.status, "pending");
});

test("replanner detects code-scope goal drift from captured workspace changes", () => {
  let state = buildState();
  state = evolveProject(state, decideChangeWorkItemStatus(state, "W-1", "ready"));
  state = evolveAll(
    state,
    decideStartAgentRun(state, {
      runId: "run-drift",
      workItemId: "W-1",
      agentId: "codex",
      role: "implementation",
      attempt: 1,
      delegationDepth: 0,
      worktreePath: "C:/worktrees/run-drift",
      branchName: "strew/run-drift",
    }),
  );
  state = evolveAll(state, decideFinishAgentRun(state, "run-drift", "succeeded"));
  const signals = new Replanner().detectAutomatic(state, {
    workItemId: "W-1",
    runId: "run-drift",
    runEvents: [],
    changedPaths: ["src/allowed.ts", "outside/drift.ts"],
  });
  assert.equal(signals.some((signal) => signal.trigger === "goal_drift"), true);
  assert.match(signals.find((signal) => signal.trigger === "goal_drift")?.currentState ?? "", /outside\/drift\.ts/);
  const caseSignals = new Replanner().detectAutomatic(state, {
    workItemId: "W-1",
    runId: "run-drift",
    runEvents: [],
    changedPaths: ["SRC/allowed.ts"],
  });
  assert.equal(caseSignals.some((signal) => signal.trigger === "goal_drift"), process.platform !== "win32");
});

test("read-only planning metadata does not trigger implementation goal drift", () => {
  let state = buildState();
  state.agents.codex.roles.push("planning");
  state.workItems["W-1"]!.allowedRoles.push("planning");
  state = evolveProject(state, decideChangeWorkItemStatus(state, "W-1", "ready"));
  state = evolveAll(state, decideStartAgentRun(state, {
    runId: "planning-metadata",
    workItemId: "W-1",
    agentId: "codex",
    role: "planning",
    attempt: 1,
    delegationDepth: 0,
    worktreePath: "C:/worktrees/planning-metadata",
    branchName: "strew/planning-metadata",
  }));
  state = evolveAll(state, decideFinishAgentRun(state, "planning-metadata", "failed"));
  const signals = new Replanner().detectAutomatic(state, {
    workItemId: "W-1",
    runId: "planning-metadata",
    runEvents: [],
    changedPaths: ["AGENTS.md", "CLAUDE.md", "memory/progress.md"],
  });
  assert.equal(signals.some((signal) => signal.trigger === "goal_drift"), false);
});

test("resolving retry exhaustion starts a new failure window and successful runs do not re-open it", () => {
  let state = buildState();
  for (const attempt of [1, 2]) {
    state = addRun(state, `old-${attempt}`, attempt, "failed", `2026-01-0${attempt}T00:00:00.000Z`);
  }
  const replanner = new Replanner();
  const exhausted = replanner.detectAutomatic(state, {
    workItemId: "W-1",
    runId: "old-2",
    runEvents: [],
  }).find((signal) => signal.trigger === "retry_exhausted");
  assert.ok(exhausted);
  const decision = replanner.buildDecision(state, exhausted);
  state = decisionPauseEvents(state, decision).reduce(evolveProject, state);
  state = evolveProject(state, decideResolveDecision(state, decision.decisionId, "replan", "2026-01-03T00:00:00.000Z"));

  state = evolveProject(state, decideChangeWorkItemStatus(state, "W-1", "ready"));
  state = addRun(state, "new-failure", 1, "failed", "2026-01-04T00:00:00.000Z", false);
  assert.equal(replanner.detectAutomatic(state, {
    workItemId: "W-1",
    runId: "new-failure",
    runEvents: [],
  }).some((signal) => signal.trigger === "retry_exhausted"), false);

  state = evolveProject(state, decideChangeWorkItemStatus(state, "W-1", "ready"));
  state = addRun(state, "new-success", 2, "succeeded", "2026-01-05T00:00:00.000Z", false);
  assert.equal(replanner.detectAutomatic(state, {
    workItemId: "W-1",
    runId: "new-success",
    runEvents: [],
  }).some((signal) => signal.trigger === "retry_exhausted"), false);
});

function buildState(): ProjectState {
  let state = emptyProjectState();
  state = evolveProject(
    state,
    decideCreateProject(state, {
      projectId: "p-1",
      name: "Strew",
      repositoryPath: "C:/workspace/strew",
      goal: "Ship safely",
      policy: { maxAttemptsPerStage: 2 },
      budget: { maxInputTokens: 10 },
    }),
  );
  for (const workItemId of ["W-1", "W-2"]) {
    state = evolveProject(
      state,
      decideAddWorkItem(state, {
        workItemId,
        kind: "task",
        title: workItemId,
        description: `Implement ${workItemId}`,
        acceptanceCriteria: ["Pass"],
        allowedRoles: ["implementation"],
        codeScopes: ["src"],
      }),
    );
  }
  state = evolveProject(
    state,
    decideAddDependency(state, {
      dependencyId: "W-1-before-W-2",
      upstreamWorkItemId: "W-1",
      downstreamWorkItemId: "W-2",
      kind: "blocks",
    }),
  );
  return evolveProject(
    state,
    decideRegisterAgent(state, {
      agentId: "codex",
      displayName: "Codex",
      adapterKind: "codex",
      capabilities: [],
      roles: ["implementation"],
      reliability: 0.9,
      costPerMillionTokens: null,
      active: true,
      maxConcurrentRuns: 1,
      createdAt: new Date().toISOString(),
    }),
  );
}

function evolveAll(state: ProjectState, events: Parameters<typeof evolveProject>[1][]): ProjectState {
  return events.reduce(evolveProject, state);
}

function addRun(
  state: ProjectState,
  runId: string,
  attempt: number,
  status: "succeeded" | "failed",
  timestamp: string,
  makeReady = true,
): ProjectState {
  let next = makeReady ? evolveProject(state, decideChangeWorkItemStatus(state, "W-1", "ready")) : state;
  next = evolveAll(
    next,
    decideStartAgentRun(next, {
      runId,
      workItemId: "W-1",
      agentId: "codex",
      role: "implementation",
      attempt,
      delegationDepth: 0,
      worktreePath: `C:/worktrees/${runId}`,
      branchName: `strew/${runId}`,
      startedAt: timestamp,
    }),
  );
  return evolveAll(next, decideFinishAgentRun(next, runId, status, timestamp));
}

function approvalEvent(runId: string): PersistedRunEvent {
  return {
    eventId: "approval-1",
    runId,
    sequence: 1,
    occurredAt: new Date().toISOString(),
    type: "approval.requested",
    raw: { permission: "network" },
  };
}
