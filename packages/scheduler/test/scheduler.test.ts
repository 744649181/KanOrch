import assert from "node:assert/strict";
import test from "node:test";

import {
  decideAddDependency,
  decideAddWorkItem,
  decideChangeWorkItemStatus,
  decideCreateProject,
  decideRegisterAgent,
  emptyProjectState,
  evolveProject,
  type AgentProfile,
  type ProjectState,
} from "../../domain/src/index.ts";
import {
  decideAcquireWorkspaceLease,
  decideReleaseWorkspaceLease,
  Scheduler,
} from "../src/index.ts";

function fixture(): ProjectState {
  let state = emptyProjectState();
  state = evolveProject(
    state,
    decideCreateProject(state, {
      projectId: "p-1",
      name: "Strew",
      repositoryPath: "C:/workspace/strew",
      goal: "Build the agent director",
    }),
  );
  for (const id of ["A", "B"]) {
    state = evolveProject(
      state,
      decideAddWorkItem(state, {
        workItemId: id,
        kind: "task",
        title: `Task ${id}`,
        description: "Implement a bounded change",
        acceptanceCriteria: ["Tests pass"],
        requiredCapabilities: ["typescript"],
        allowedRoles: ["implementation"],
        codeScopes: id === "A" ? ["src/runtime"] : ["src/web"],
      }),
    );
    state = evolveProject(state, decideChangeWorkItemStatus(state, id, "ready"));
  }
  return state;
}

function addAgent(state: ProjectState, agent: AgentProfile): ProjectState {
  return evolveProject(state, decideRegisterAgent(state, agent));
}

test("scheduler enforces dependencies, capabilities, load, and deterministic scoring", () => {
  let state = fixture();
  state = evolveProject(
    state,
    decideAddDependency(state, {
      dependencyId: "A-before-B",
      upstreamWorkItemId: "A",
      downstreamWorkItemId: "B",
      kind: "blocks",
    }),
  );
  state = addAgent(state, {
    agentId: "codex",
    displayName: "Codex",
    adapterKind: "codex",
    capabilities: ["typescript", "sqlite"],
    roles: ["implementation"],
    reliability: 0.95,
    costPerMillionTokens: 10,
    active: true,
    maxConcurrentRuns: 1,
    createdAt: new Date().toISOString(),
  });
  state = addAgent(state, {
    agentId: "opencode",
    displayName: "OpenCode",
    adapterKind: "opencode",
    capabilities: ["typescript"],
    roles: ["implementation"],
    reliability: 0.85,
    costPerMillionTokens: null,
    active: true,
    maxConcurrentRuns: 1,
    createdAt: new Date().toISOString(),
  });
  const scheduler = new Scheduler();
  assert.deepEqual(scheduler.listRoutable(state, "implementation").map((item) => item.workItemId), ["A"]);
  assert.equal(scheduler.route(state, "A", "implementation").agentId, "codex");
  assert.throws(() => scheduler.route(state, "B", "implementation"), /blocked by A/);
});
test("workspace leases enforce a single writer for overlapping code areas", () => {
  let state = fixture();
  state = evolveProject(
    state,
    decideAcquireWorkspaceLease(state, {
      leaseId: "lease-a",
      workItemId: "A",
      runId: "run-a",
      worktreePath: "C:/worktrees/a",
      branchName: "strew/a",
      codeScopes: ["src/runtime"],
    }),
  );
  assert.throws(
    () =>
      decideAcquireWorkspaceLease(state, {
        workItemId: "B",
        runId: "run-b",
        worktreePath: "C:/worktrees/b",
        branchName: "strew/b",
        codeScopes: ["src/runtime/server"],
      }),
    /conflicts with 'lease-a'/,
  );
  assert.doesNotThrow(() =>
    decideAcquireWorkspaceLease(state, {
      workItemId: "B",
      runId: "run-b",
      worktreePath: "C:/worktrees/b",
      branchName: "strew/b",
      codeScopes: ["src/web"],
    }),
  );
  state = evolveProject(state, decideReleaseWorkspaceLease(state, "lease-a"));
  assert.doesNotThrow(() =>
    decideAcquireWorkspaceLease(state, {
      workItemId: "B",
      runId: "run-b",
      worktreePath: "C:/worktrees/b",
      branchName: "strew/b",
      codeScopes: ["src/runtime/server"],
    }),
  );
});
