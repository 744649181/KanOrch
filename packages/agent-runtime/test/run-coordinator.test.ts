import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgentAdapterRegistry,
  type AdapterOutputEvent,
  type AgentAdapter,
  type AgentLaunchRequest,
  type AgentLaunchSpec,
} from "../../agent-protocol/src/index.ts";
import {
  decideAddWorkItem,
  decideChangeWorkItemStatus,
  decideCreateProject,
  decideRegisterAgent,
} from "../../domain/src/index.ts";
import { ProjectRepository } from "../../control-plane/src/index.ts";
import { SqliteEventStore } from "../../event-store/src/index.ts";
import { AgentInbox, aggregateUsage, inferStageVerdict, RunCoordinator } from "../src/index.ts";

test("OpenCode step usage is summed while cumulative provider totals remain bounded", () => {
  const usage = (sequence: number, providerEventType: string, inputTokens: number, outputTokens: number, costUsd: number) => ({
    eventId: `usage-${sequence}`, runId: "run-usage", sequence, occurredAt: "2026-09-28T00:00:00Z",
    type: "usage.updated" as const, providerEventType, inputTokens, outputTokens, costUsd, raw: {},
  });
  const steps = [usage(1, "step_finish", 10, 2, 0.25), usage(2, "step_finish", 20, 3, 0.5)];
  assert.deepEqual(aggregateUsage(steps), { inputTokens: 30, outputTokens: 5, costUsd: 0.75 });
  assert.deepEqual(aggregateUsage([...steps, usage(3, "result", 40, 6, 1)]), {
    inputTokens: 40, outputTokens: 6, costUsd: 1,
  });
});

test("review and testing require an explicit machine-readable PASS verdict", () => {
  const event = (message: string) => ({
    eventId: crypto.randomUUID(),
    runId: "run-verdict",
    sequence: 1,
    occurredAt: new Date().toISOString(),
    type: "output.delta" as const,
    message,
    raw: message,
  });
  assert.equal(inferStageVerdict("review", [event("looks good")]), "missing");
  assert.equal(inferStageVerdict("review", [event("STREW_VERDICT: PASS")]), "passed");
  assert.equal(inferStageVerdict("testing", [event("STREW_VERDICT: FAIL")]), "failed");
  assert.equal(inferStageVerdict("implementation", []), "passed");
});

test("run coordinator executes an adapter in a leased worktree and persists logs, diff, usage, and evidence", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "strew-run-coordinator-"));
  const repositoryPath = join(sandbox, "repository");
  const worktreeRoot = join(sandbox, "worktrees");
  const store = new SqliteEventStore(":memory:");
  try {
    git(sandbox, ["init", repositoryPath]);
    git(repositoryPath, ["config", "user.email", "strew@example.invalid"]);
    git(repositoryPath, ["config", "user.name", "Strew Test"]);
    writeFileSync(join(repositoryPath, "README.md"), "base\n", "utf8");
    git(repositoryPath, ["add", "README.md"]);
    git(repositoryPath, ["commit", "-m", "Base"]);

    const repository = new ProjectRepository(store);
    let result = repository.createProject(
      {
        projectId: "p-1",
        name: "Strew",
        repositoryPath,
        goal: "Execute one isolated run",
      },
      context(0, "create"),
    );
    result = repository.addWorkItem(
      "p-1",
      {
        workItemId: "W-1",
        kind: "task",
        title: "Change README",
        description: "Append a verified line",
        acceptanceCriteria: ["Diff is captured"],
        allowedRoles: ["implementation"],
        codeScopes: ["README.md"],
      },
      context(result.revision, "add-work"),
    );
    result = repository.registerAgent(
      "p-1",
      {
        agentId: "fixture-agent",
        displayName: "Fixture Agent",
        adapterKind: "external",
        capabilities: [],
        roles: ["implementation"],
        reliability: 1,
        costPerMillionTokens: 1,
        active: true,
        maxConcurrentRuns: 1,
        createdAt: new Date().toISOString(),
      },
      context(result.revision, "register-agent"),
    );
    result = repository.changeWorkItemStatus(
      "p-1",
      "W-1",
      "ready",
      context(result.revision, "ready"),
    );
    result = repository.registerAgent("p-1", {
      agentId: "source-agent", displayName: "Source Agent", adapterKind: "external",
      capabilities: [], roles: ["implementation"], reliability: 1,
      costPerMillionTokens: null, active: true, maxConcurrentRuns: 1,
      createdAt: new Date().toISOString(),
    }, context(result.revision, "register-source"));
    result = repository.startAgentRun("p-1", {
      runId: "source-run", workItemId: "W-1", agentId: "source-agent", role: "implementation",
      attempt: 1, delegationDepth: 0, worktreePath: "fixture-source", branchName: "fixture/source",
    }, context(result.revision, "start-source"));
    result = repository.finishAgentRun("p-1", "source-run", "succeeded", context(result.revision, "finish-source"));
    result = repository.changeWorkItemStatus("p-1", "W-1", "ready", context(result.revision, "ready-again"));
    result = repository.recordAgentHandoff("p-1", {
      messageId: crypto.randomUUID(), workItemId: "W-1", sourceRunId: "source-run",
      recipientAgentId: "fixture-agent", kind: "handoff", summary: "Verify the first change", artifactIds: [],
    }, context(result.revision, "handoff"));

    const adapters = new AgentAdapterRegistry();
    const fixture = new FixtureAdapter();
    adapters.register(fixture);
    const inbox = new AgentInbox(repository);
    inbox.setOrigin("http://127.0.0.1:9999");
    const coordinator = new RunCoordinator({
      repository,
      adapters,
      inbox,
      worktreeRoot: () => worktreeRoot,
    });
    const execution = await coordinator.execute({
      projectId: "p-1",
      workItemId: "W-1",
      role: "implementation",
      agentId: "fixture-agent",
      runId: "run-1",
      prompt: "Append a line",
      permissionMode: "workspace-auto",
    });

    assert.equal(execution.status, "succeeded");
    assert.match(fixture.lastPrompt, /Verify the first change/);
    assert.match(fixture.lastPrompt, /KanOrch inbox:/);
    assert.ok(fixture.lastToken);
    assert.throws(() => inbox.list(fixture.lastToken), /invalid or expired/);
    assert.equal(execution.budgetEntry.inputTokens, 12);
    assert.equal(execution.budgetEntry.outputTokens, 5);
    assert.equal(execution.budgetEntry.costUsd, 0.01);
    assert.equal(execution.artifacts.some((artifact) => artifact.kind === "log"), true);
    assert.equal(execution.artifacts.some((artifact) => artifact.kind === "diff"), true);
    assert.equal(execution.evidence?.kind, "implementation");

    const final = repository.load("p-1").state;
    assert.equal(final.runs["run-1"]?.status, "succeeded");
    assert.equal(final.workspaceLeases["lease-run-1"]?.status, "released");
    assert.equal(Object.keys(final.artifacts).length, 3);
    assert.equal(Object.keys(final.evidence).length, 1);
    assert.equal(Object.keys(final.budgetEntries).length, 1);
    assert.equal(store.readStream("run:run-1").length > 0, true);
  } finally {
    store.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

class FixtureAdapter implements AgentAdapter {
  readonly kind = "external" as const;
  readonly displayName = "Fixture Agent";
  readonly executable = process.execPath;
  lastPrompt = "";
  lastToken = "";

  buildLaunchSpec(request: AgentLaunchRequest): AgentLaunchSpec {
    this.lastPrompt = request.prompt;
    this.lastToken = request.extraEnvironment?.KANORCH_INBOX_TOKEN ?? "";
    const script = [
      "const fs = require('node:fs')",
      "fs.appendFileSync('README.md', 'agent change\\n')",
      "console.log(JSON.stringify({type:'usage',inputTokens:12,outputTokens:5,costUsd:0.01}))",
    ].join(";");
    return {
      adapterKind: this.kind,
      executable: this.executable,
      args: ["-e", script],
      cwd: request.workspacePath,
      stdin: null,
      environment: {},
    };
  }

  parseStdoutLine(line: string): AdapterOutputEvent[] {
    const body = JSON.parse(line) as { inputTokens: number; outputTokens: number; costUsd: number };
    return [{ type: "usage.updated", ...body, raw: body }];
  }
}

function context(expectedRevision: number, idempotencyKey: string) {
  return { expectedRevision, idempotencyKey, actorType: "user" as const, actorId: "test" };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
