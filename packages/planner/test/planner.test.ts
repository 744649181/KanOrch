import assert from "node:assert/strict";
import test from "node:test";

import type { PersistedRunEvent } from "../../agent-protocol/src/index.ts";
import {
  defaultProjectPolicy,
  DomainRuleError,
} from "../../domain/src/index.ts";
import { ProjectRepository } from "../../control-plane/src/index.ts";
import { SqliteEventStore } from "../../event-store/src/index.ts";
import {
  DagPlanner,
  parseWorkGraphPlan,
  type PlanningRunExecutor,
  type WorkGraphPlan,
} from "../src/index.ts";

const validPlan: WorkGraphPlan = {
  version: 1,
  summary: "Build and verify the feature",
  workItems: [
    {
      workItemId: "S-002",
      parentWorkItemId: "S-001",
      kind: "task",
      title: "Implement API",
      description: "Implement the validated API boundary.",
      acceptanceCriteria: ["API tests pass"],
      requiredCapabilities: ["typescript"],
      codeScopes: ["src/api"],
    },
    {
      workItemId: "S-001",
      parentWorkItemId: null,
      kind: "story",
      title: "Define contract",
      description: "Define the public contract and test cases.",
      acceptanceCriteria: ["Contract is documented"],
      requiredCapabilities: ["architecture"],
      codeScopes: ["src/contracts"],
    },
  ],
  dependencies: [
    { upstreamWorkItemId: "S-001", downstreamWorkItemId: "S-002", kind: "blocks" },
  ],
};

test("planner contract parses marked JSON and orders parents before children", () => {
  const plan = parseWorkGraphPlan(marked(validPlan), defaultProjectPolicy());
  assert.deepEqual(plan.workItems.map((item) => item.workItemId), ["S-001", "S-002"]);
});

test("planner contract rejects cycles, unsafe scopes, and excess depth", () => {
  const cycle = {
    ...validPlan,
    dependencies: [
      { upstreamWorkItemId: "S-001", downstreamWorkItemId: "S-002", kind: "blocks" },
      { upstreamWorkItemId: "S-002", downstreamWorkItemId: "S-001", kind: "blocks" },
    ],
  };
  assert.throws(() => parseWorkGraphPlan(marked(cycle), defaultProjectPolicy()), /cycle/i);
  const unsafe = structuredClone(validPlan);
  unsafe.workItems[0].codeScopes = ["../outside"];
  assert.throws(() => parseWorkGraphPlan(marked(unsafe), defaultProjectPolicy()), /unsafe code scope/i);
  const shallowPolicy = { ...defaultProjectPolicy(), maxDecompositionDepth: 0 };
  assert.throws(() => parseWorkGraphPlan(marked(validPlan), shallowPolicy), /maxDecompositionDepth/i);
});

test("DAG planner retries invalid output then atomically persists a ready entry graph", async () => {
  const repository = repositoryWithProject(2);
  let calls = 0;
  let planningCalls = 0;
  const runner: PlanningRunExecutor = {
    async execute(input) {
      calls += 1;
      if (input.role === "review") return execution(`run-${calls}`, "STREW_VERDICT: PASS", "claude");
      planningCalls += 1;
      return execution(`run-${calls}`, planningCalls === 1 ? "invalid" : marked(validPlan));
    },
  };
  const result = await new DagPlanner(repository, runner).planProject({ projectId: "planned" });
  assert.equal(result.status, "planned");
  assert.equal(calls, 3);
  assert.equal(result.project.state.workItems["STREW-PLAN"]?.ownStatus, "done");
  assert.equal(result.project.state.workItems["S-001"]?.ownStatus, "ready");
  assert.equal(result.project.state.workItems["S-002"]?.ownStatus, "backlog");
  assert.equal(Object.keys(result.project.state.dependencies).length, 1);
});

test("DAG planner rotates planning agents and preserves process failure diagnostics", async () => {
  const repository = repositoryWithProject(3);
  const plannerAgentIds: Array<string | undefined> = [];
  const runner: PlanningRunExecutor = {
    async execute(input) {
      if (input.role === "review") {
        return execution(`review-${input.attempt}`, "STREW_VERDICT: PASS", input.agentId ?? "codex");
      }
      plannerAgentIds.push(input.agentId);
      if (plannerAgentIds.length === 1) {
        return failedExecution("plan-failed", "Agent process could not start: spawn codex ENOENT", input.agentId ?? "codex");
      }
      return execution("plan-succeeded", marked(validPlan), input.agentId ?? "claude");
    },
  };
  const result = await new DagPlanner(repository, runner).planProject({ projectId: "planned" });
  assert.equal(result.status, "planned");
  assert.deepEqual(plannerAgentIds, ["codex", "claude"]);
  assert.match(result.attempts.join("\n"), /spawn codex ENOENT/);
});

test("DAG planner exhausts invalid attempts into a persisted decision", async () => {
  const repository = repositoryWithProject(2);
  const runner: PlanningRunExecutor = {
    async execute(input) {
      return execution(`invalid-${input.attempt}`, "not a plan");
    },
  };
  const result = await new DagPlanner(repository, runner).planProject({ projectId: "planned" });
  assert.equal(result.status, "blocked");
  assert.ok(result.decisionId);
  assert.equal(result.project.state.workItems["STREW-PLAN"]?.ownStatus, "blocked");
  assert.equal(result.project.state.decisions[result.decisionId ?? ""]?.trigger, "retry_exhausted");
});

test("DAG planner retries a rejected independent review and pauses at the limit", async () => {
  const repository = repositoryWithProject(2);
  const runner: PlanningRunExecutor = {
    async execute(input) {
      if (input.role === "planning") return execution(`plan-${input.attempt}`, marked(validPlan));
      return execution(`review-${input.attempt}`, "Review returned without a machine verdict", "claude");
    },
  };
  const result = await new DagPlanner(repository, runner).planProject({ projectId: "planned" });
  assert.equal(result.status, "blocked");
  assert.equal(result.runIds.length, 4);
  assert.match(result.attempts.join("\n"), /independent plan review/i);
  assert.equal(result.project.state.decisions[result.decisionId ?? ""]?.trigger, "retry_exhausted");
});

test("invalid planned dependency rolls back every graph event", () => {
  const repository = repositoryWithProject(1);
  const beforeRoot = repository.load("planned");
  const added = repository.addWorkItem(
    "planned",
    {
      workItemId: "STREW-PLAN",
      kind: "goal",
      title: "Plan",
      description: "Generate graph",
      acceptanceCriteria: ["Graph exists"],
      allowedRoles: ["planning"],
      codeScopes: [".strew-plan"],
    },
    context(beforeRoot.revision, "root"),
  );
  assert.throws(
    () => repository.applyPlannedWorkGraph(
      "planned",
      {
        planRootWorkItemId: "STREW-PLAN",
        workItems: validPlan.workItems.map((item) => ({ ...item, allowedRoles: ["implementation"] })),
        dependencies: [
          { upstreamWorkItemId: "S-001", downstreamWorkItemId: "S-002", kind: "blocks" },
          { upstreamWorkItemId: "S-002", downstreamWorkItemId: "S-001", kind: "blocks" },
        ],
      },
      context(added.revision, "invalid-graph"),
    ),
    DomainRuleError,
  );
  const current = repository.load("planned");
  assert.deepEqual(Object.keys(current.state.workItems), ["STREW-PLAN"]);
  assert.equal(Object.keys(current.state.dependencies).length, 0);
});

function repositoryWithProject(maxAttemptsPerStage: number): ProjectRepository {
  const repository = new ProjectRepository(new SqliteEventStore(":memory:"));
  let current = repository.createProject(
    {
      projectId: "planned",
      name: "Planned",
      repositoryPath: "C:/workspace/planned",
      goal: "Build a reliable API",
      policy: { maxAttemptsPerStage },
    },
    context(0, "create"),
  );
  for (const [agentId, roles] of [
    ["codex", ["planning", "implementation", "review", "testing"]],
    ["claude", ["planning", "implementation", "review", "testing"]],
  ] as const) {
    current = repository.registerAgent(
      "planned",
      {
        agentId,
        displayName: agentId,
        adapterKind: agentId === "codex" ? "codex" : "claude-code",
        capabilities: ["architecture", "testing", "typescript"],
        roles: [...roles] as Array<"planning" | "implementation" | "review" | "testing">,
        reliability: agentId === "codex" ? 1 : 0.9,
        costPerMillionTokens: null,
        active: true,
        maxConcurrentRuns: 1,
        createdAt: new Date().toISOString(),
      },
      context(current.revision, `register-${agentId}`),
    );
  }
  return repository;
}

function execution(runId: string, output: string, agentId = "codex") {
  return {
    runId,
    agentId,
    status: "succeeded" as const,
    events: [event(runId, output)],
  };
}

function failedExecution(runId: string, output: string, agentId: string) {
  return {
    runId,
    agentId,
    status: "failed" as const,
    events: [event(runId, output)],
  };
}

function event(runId: string, message: string): PersistedRunEvent {
  return {
    eventId: `${runId}-event`,
    runId,
    sequence: 1,
    occurredAt: new Date().toISOString(),
    type: "output.delta",
    message,
    raw: { message },
  };
}

function marked(value: unknown): string {
  return `STREW_PLAN_JSON\n${JSON.stringify(value)}\nSTREW_PLAN_END`;
}

function context(expectedRevision: number, idempotencyKey: string) {
  return { expectedRevision, idempotencyKey, actorType: "system" as const, actorId: "test" };
}
