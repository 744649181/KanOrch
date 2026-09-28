import assert from "node:assert/strict";
import test from "node:test";

import {
  decideAddWorkItem,
  decideChangeWorkItemStatus,
  decideCreateProject,
  decideFinishAgentRun,
  decideRecordBudgetEntry,
  decideRecordEvidence,
  decideRegisterAgent,
  decideStartAgentRun,
  emptyProjectState,
  evolveProject,
  type AgentProfile,
  type Evidence,
  type FunctionalRole,
  type ProjectState,
} from "../../domain/src/index.ts";
import {
  decideCompleteWorkItem,
  evaluateQualityGates,
  MergeAuthorizationError,
  MergeController,
  QualityGateError,
} from "../src/index.ts";

test("Done and automatic merge require implementation, independent review, tests, budget, and clear decisions", async () => {
  let state = buildProject();
  assert.throws(() => decideCompleteWorkItem(state, "W-1"), QualityGateError);

  state = completeStage(state, "implementation", "implementer", "run-implementation");
  state = recordEvidence(state, {
    evidenceId: "e-implementation",
    runId: "run-implementation",
    producerAgentId: "implementer",
    kind: "implementation",
    subjectRunId: null,
  });
  state = completeStage(state, "review", "reviewer", "run-review");
  state = recordEvidence(state, {
    evidenceId: "e-review",
    runId: "run-review",
    producerAgentId: "reviewer",
    kind: "review",
    subjectRunId: "run-implementation",
  });
  state = completeStage(state, "testing", "tester", "run-test");
  state = recordEvidence(state, {
    evidenceId: "e-test",
    runId: "run-test",
    producerAgentId: "tester",
    kind: "test",
    subjectRunId: "run-implementation",
  });

  const report = evaluateQualityGates(state, "W-1");
  assert.equal(report.passed, true);
  state = evolveProject(state, decideCompleteWorkItem(state, "W-1"));
  assert.equal(state.workItems["W-1"]?.ownStatus, "done");

  let mergeCalls = 0;
  const controller = new MergeController({
    async merge(request) {
      mergeCalls += 1;
      return { commitSha: "a".repeat(40), summary: `${request.sourceBranch} -> ${request.targetBranch}` };
    },
  });
  const merged = await controller.mergeWhenAuthorized(state, {
    workItemId: "W-1",
    sourceBranch: "strew/run-implementation",
    targetBranch: "main",
    expectedSourceCommit: "a".repeat(40),
  });
  assert.equal(merged.result.commitSha, "a".repeat(40));
  assert.equal(mergeCalls, 1);

  state = evolveProject(
    state,
    decideRecordBudgetEntry(state, {
      budgetEntryId: "b-over",
      projectId: "p-1",
      workItemId: "W-1",
      runId: "run-implementation",
      kind: "actual",
      inputTokens: 101,
      outputTokens: 0,
      costUsd: 0,
      wallClockSeconds: 0,
      createdAt: new Date().toISOString(),
    }),
  );
  await assert.rejects(
    controller.mergeWhenAuthorized(state, {
      workItemId: "W-1",
      sourceBranch: "strew/run-implementation",
      targetBranch: "main",
      expectedSourceCommit: "a".repeat(40),
    }),
    MergeAuthorizationError,
  );
  assert.equal(mergeCalls, 1, "executor must not run when a gate fails");
});

test("merge cannot reuse review and test evidence from another implementation run", async () => {
  let state = buildProject();
  state = completeStage(state, "implementation", "implementer", "run-a");
  state = recordEvidence(state, { evidenceId: "e-a", runId: "run-a", producerAgentId: "implementer", kind: "implementation", subjectRunId: null });
  state = completeStage(state, "review", "reviewer", "review-a");
  state = recordEvidence(state, { evidenceId: "r-a", runId: "review-a", producerAgentId: "reviewer", kind: "review", subjectRunId: "run-a" });
  state = completeStage(state, "testing", "tester", "test-a");
  state = recordEvidence(state, { evidenceId: "t-a", runId: "test-a", producerAgentId: "tester", kind: "test", subjectRunId: "run-a" });
  state = completeStage(state, "implementation", "implementer", "run-b");
  state = recordEvidence(state, { evidenceId: "e-b", runId: "run-b", producerAgentId: "implementer", kind: "implementation", subjectRunId: null });
  assert.equal(evaluateQualityGates(state, "W-1").passed, true, "the reviewed candidate remains valid");
  let merged = false;
  const controller = new MergeController({ async merge() { merged = true; return { commitSha: "a".repeat(40), summary: "merged" }; } });
  await assert.rejects(controller.mergeWhenAuthorized(state, {
    workItemId: "W-1", sourceBranch: "strew/run-b", targetBranch: "main", expectedSourceCommit: "a".repeat(40),
  }), MergeAuthorizationError);
  assert.equal(merged, false);
});

test("review evidence cannot claim independence from the same agent identity", () => {
  let state = buildProject({ requireIndependentReview: false });
  state = completeStage(state, "implementation", "implementer", "run-implementation");
  state = evolveProject(state, decideChangeWorkItemStatus(state, "W-1", "ready"));
  state = evolveAll(
    state,
    decideStartAgentRun(state, {
      runId: "run-review",
      workItemId: "W-1",
      agentId: "implementer",
      role: "review",
      attempt: 1,
      delegationDepth: 0,
      worktreePath: "C:/worktrees/review",
      branchName: "strew/review",
    }),
  );
  state = evolveAll(state, decideFinishAgentRun(state, "run-review", "succeeded"));
  assert.throws(
    () =>
      decideRecordEvidence(state, {
        ...evidenceFixture({
          evidenceId: "fake-review",
          runId: "run-review",
          producerAgentId: "implementer",
          kind: "review",
          subjectRunId: "run-implementation",
        }),
      }),
    /cannot be produced by the implementation agent/,
  );
});

function buildProject(policy: { requireIndependentReview?: boolean } = {}): ProjectState {
  let state = emptyProjectState();
  state = evolveProject(
    state,
    decideCreateProject(state, {
      projectId: "p-1",
      name: "Strew",
      repositoryPath: "C:/workspace/strew",
      goal: "Ship safely",
      policy,
      budget: { maxInputTokens: 100 },
    }),
  );
  state = evolveProject(
    state,
    decideAddWorkItem(state, {
      workItemId: "W-1",
      kind: "task",
      title: "Implement feature",
      description: "Implement, review, and test it",
      acceptanceCriteria: ["All gates pass"],
      allowedRoles: ["implementation", "review", "testing"],
    }),
  );
  for (const agent of [
    agentFixture("implementer", ["implementation", "review"]),
    agentFixture("reviewer", ["review"]),
    agentFixture("tester", ["testing"]),
  ]) {
    state = evolveProject(state, decideRegisterAgent(state, agent));
  }
  return state;
}

function completeStage(
  state: ProjectState,
  role: FunctionalRole,
  agentId: string,
  runId: string,
): ProjectState {
  state = evolveProject(state, decideChangeWorkItemStatus(state, "W-1", "ready"));
  state = evolveAll(
    state,
    decideStartAgentRun(state, {
      runId,
      workItemId: "W-1",
      agentId,
      role,
      attempt: 1,
      delegationDepth: 0,
      worktreePath: `C:/worktrees/${runId}`,
      branchName: `strew/${runId}`,
    }),
  );
  return evolveAll(state, decideFinishAgentRun(state, runId, "succeeded"));
}

function recordEvidence(
  state: ProjectState,
  input: Pick<Evidence, "evidenceId" | "runId" | "producerAgentId" | "kind" | "subjectRunId">,
): ProjectState {
  return evolveProject(state, decideRecordEvidence(state, evidenceFixture(input)));
}

function evidenceFixture(
  input: Pick<Evidence, "evidenceId" | "runId" | "producerAgentId" | "kind" | "subjectRunId">,
): Evidence {
  return {
    ...input,
    projectId: "p-1",
    workItemId: "W-1",
    verdict: "passed",
    summary: `${input.kind} passed`,
    artifactIds: [],
    imported: false,
    createdAt: new Date().toISOString(),
  };
}

function agentFixture(agentId: string, roles: FunctionalRole[]): AgentProfile {
  return {
    agentId,
    displayName: agentId,
    adapterKind: "external",
    capabilities: [],
    roles,
    reliability: 0.9,
    costPerMillionTokens: null,
    active: true,
    maxConcurrentRuns: 1,
    createdAt: new Date().toISOString(),
  };
}

function evolveAll(state: ProjectState, events: ReturnType<typeof decideStartAgentRun>): ProjectState {
  return events.reduce(evolveProject, state);
}
