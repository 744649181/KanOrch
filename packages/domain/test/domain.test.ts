import assert from "node:assert/strict";
import test from "node:test";

import {
  decideAddDependency,
  decideAddWorkItem,
  decideChangeWorkItemStatus,
  decideCreateProject,
  decideRegisterAgent,
  decideRecordAgentHandoff,
  decideAcknowledgeAgentHandoff,
  decideRequestDecision,
  decideSetWorkItemRoles,
  decideStartAgentRun,
  DomainRuleError,
  emptyProjectState,
  evolveProject,
  type AgentProfile,
  type DecisionRequest,
  type ProjectState,
} from "../src/index.ts";

function createState(policy = {}): ProjectState {
  const empty = emptyProjectState();
  return evolveProject(
    empty,
    decideCreateProject(empty, {
      projectId: "p-1",
      name: "Strew",
      repositoryPath: "C:/workspace/strew",
      goal: "Build an agent director",
      policy,
      createdAt: "2026-08-24T00:00:00.000Z",
    }),
  );
}

function addItem(
  state: ProjectState,
  workItemId: string,
  parentWorkItemId: string | null = null,
): ProjectState {
  return evolveProject(
    state,
    decideAddWorkItem(state, {
      workItemId,
      parentWorkItemId,
      kind: "task",
      title: `Task ${workItemId}`,
      description: "A real task",
      acceptanceCriteria: ["Observable result"],
      requiredCapabilities: ["typescript"],
      allowedRoles: ["implementation", "review"],
      createdAt: "2026-08-24T00:00:00.000Z",
    }),
  );
}

function registerAgent(state: ProjectState, agentId: string): ProjectState {
  const agent: AgentProfile = {
    agentId,
    displayName: agentId,
    adapterKind: "codex",
    capabilities: ["typescript"],
    roles: ["implementation", "review"],
    reliability: 0.9,
    costPerMillionTokens: null,
    active: true,
    maxConcurrentRuns: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
  };
  return evolveProject(state, decideRegisterAgent(state, agent));
}

test("work item roles can be audited and revised only outside active runs", () => {
  let state = addItem(createState(), "W-1");
  state = registerAgent(state, "writer");
  state = evolveProject(state, decideSetWorkItemRoles(state, "W-1", ["testing", "review", "implementation", "review"]));
  assert.deepEqual(state.workItems["W-1"]?.allowedRoles, ["implementation", "review", "testing"]);
  state = evolveProject(state, decideChangeWorkItemStatus(state, "W-1", "ready"));
  state = decideStartAgentRun(state, {
    runId: "run-roles", workItemId: "W-1", agentId: "writer", role: "implementation",
    attempt: 1, delegationDepth: 0, worktreePath: "C:/worktrees/roles", branchName: "test/roles",
  }).reduce(evolveProject, state);
  assert.throws(() => decideSetWorkItemRoles(state, "W-1", ["review"]), /cannot change roles/);
});

test("handoff stays directed and rejects unrelated artifacts", () => {
  let state = addItem(createState(), "W-1");
  state = registerAgent(registerAgent(state, "writer"), "reviewer");
  state = evolveProject(state, decideChangeWorkItemStatus(state, "W-1", "ready"));
  state = decideStartAgentRun(state, {
    runId: "source-run", workItemId: "W-1", agentId: "writer", role: "implementation",
    attempt: 1, delegationDepth: 0, worktreePath: "C:/worktrees/w-1", branchName: "test/w-1",
  }).reduce(evolveProject, state);
  const message = {
    messageId: "message-1", workItemId: "W-1", sourceRunId: "source-run",
    recipientAgentId: "reviewer", kind: "review_request" as const,
    summary: "Inspect the changed behavior", artifactIds: [] as string[],
  };
  assert.throws(() => decideRecordAgentHandoff(state, { ...message, artifactIds: ["elsewhere"] }), /does not belong to source run/);
  assert.throws(() => decideRecordAgentHandoff(state, { ...message, recipientAgentId: "writer" }), /another agent/);
  state = evolveProject(state, decideRecordAgentHandoff(state, message));
  assert.equal(state.handoffs["message-1"]?.recipientAgentId, "reviewer");
  assert.throws(() => decideAcknowledgeAgentHandoff(state, "message-1", "source-run"), /recipient run/);
  assert.throws(() => decideRecordAgentHandoff(state, message), /already exists/);
});

test("decomposition and delegation depth are independent policies", () => {
  let state = createState({ maxDecompositionDepth: 1, maxAgentDelegationDepth: 3 });
  state = addItem(state, "root");
  state = addItem(state, "child", "root");
  assert.throws(() => addItem(state, "grandchild", "child"), /maxDecompositionDepth 1/);
});
test("directed work dependencies reject cycles and block execution", () => {
  let state = addItem(addItem(createState(), "A"), "B");
  state = evolveProject(
    state,
    decideAddDependency(state, {
      dependencyId: "dep-a-b",
      upstreamWorkItemId: "A",
      downstreamWorkItemId: "B",
      kind: "blocks",
      createdAt: "2026-08-24T00:00:00.000Z",
    }),
  );
  assert.throws(
    () =>
      decideAddDependency(state, {
        upstreamWorkItemId: "B",
        downstreamWorkItemId: "A",
        kind: "blocks",
      }),
    /creates a cycle/,
  );
  state = registerAgent(state, "codex");
  state = evolveProject(state, decideChangeWorkItemStatus(state, "B", "ready"));
  assert.throws(
    () =>
      decideStartAgentRun(state, {
        workItemId: "B",
        agentId: "codex",
        role: "implementation",
        attempt: 1,
        delegationDepth: 0,
        worktreePath: "C:/worktrees/b",
        branchName: "strew/b",
      }),
    /blocked by A/,
  );
});

test("independent reviewer cannot be the implementation agent", () => {
  let state = registerAgent(addItem(createState(), "A"), "codex");
  state = registerAgent(state, "claude");
  state = evolveProject(state, decideChangeWorkItemStatus(state, "A", "ready"));
  for (const event of decideStartAgentRun(state, {
    runId: "run-impl",
    workItemId: "A",
    agentId: "codex",
    role: "implementation",
    attempt: 1,
    delegationDepth: 0,
    worktreePath: "C:/worktrees/a",
    branchName: "strew/a",
  })) {
    state = evolveProject(state, event);
  }
  state = evolveProject(state, {
    eventType: "agent_run.finished",
    payload: { runId: "run-impl", status: "succeeded", finishedAt: "2026-08-24T01:00:00.000Z" },
  });
  state = evolveProject(state, decideChangeWorkItemStatus(state, "A", "ready"));
  assert.throws(
    () =>
      decideStartAgentRun(state, {
        workItemId: "A",
        agentId: "codex",
        role: "review",
        attempt: 1,
        delegationDepth: 0,
        worktreePath: "C:/worktrees/a-review",
        branchName: "strew/a-review",
      }),
    /cannot independently review/,
  );
  assert.doesNotThrow(() =>
    decideStartAgentRun(state, {
      workItemId: "A",
      agentId: "claude",
      role: "review",
      attempt: 1,
      delegationDepth: 0,
      worktreePath: "C:/worktrees/a-review",
      branchName: "strew/a-review",
    }),
  );
});

test("decision requests require complete context and two or three options", () => {
  const state = createState();
  const decision: DecisionRequest = {
    decisionId: "D-1",
    projectId: "p-1",
    workItemId: null,
    trigger: "retry_exhausted",
    status: "pending",
    objective: "Build the event store",
    currentState: "Three migration attempts failed",
    architectureSummary: "TypeScript runtime over SQLite",
    logicStack: ["runtime", "event-store", "sqlite"],
    bottleneck: "legacy JSON import ordering",
    attempts: ["direct import", "batch import", "cursor import"],
    affectedWorkItemIds: ["S-1"],
    options: [
      {
        optionId: "bounded-import",
        title: "Bound the importer",
        description: "Import one project transactionally",
        estimatedTokens: 50_000,
        estimatedSeconds: 3_600,
        risk: "low",
      },
      {
        optionId: "rewrite",
        title: "Rewrite source data",
        description: "Normalize legacy files before import",
        estimatedTokens: 100_000,
        estimatedSeconds: 7_200,
        risk: "medium",
      },
    ],
    recommendedOptionId: "bounded-import",
    recommendationReason: "Preserves history with the smallest affected surface",
    selectedOptionId: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    resolvedAt: null,
  };
  assert.equal(decideRequestDecision(state, decision).eventType, "decision.requested");
  assert.throws(
    () => decideRequestDecision(state, { ...decision, decisionId: "D-2", bottleneck: "" }),
    DomainRuleError,
  );
});
