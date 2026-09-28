import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { RunCoordinator } from "../../agent-runtime/src/index.ts";
import { ProjectRepository } from "../../control-plane/src/index.ts";
import { SqliteEventStore } from "../../event-store/src/index.ts";
import { Director } from "../src/index.ts";

test("director automatically implements, independently reviews, tests, quality-gates, and merges a work item", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "strew-director-"));
  const repositoryPath = join(sandbox, "repository");
  const store = new SqliteEventStore(":memory:");
  try {
    git(sandbox, ["init", "-b", "main", repositoryPath]);
    git(repositoryPath, ["config", "user.email", "strew@example.invalid"]);
    git(repositoryPath, ["config", "user.name", "Strew Test"]);
    writeFileSync(join(repositoryPath, "README.md"), "base\n", "utf8");
    git(repositoryPath, ["add", "README.md"]);
    git(repositoryPath, ["commit", "-m", "Base"]);

    const repository = new ProjectRepository(store);
    let command = repository.createProject(
      {
        projectId: "p-1",
        name: "Strew",
        repositoryPath,
        baseBranch: "main",
        goal: "Deliver a reviewed feature",
        policy: { maxAttemptsPerStage: 2 },
      },
      context(0, "create"),
    );
    command = repository.addWorkItem(
      "p-1",
      {
        workItemId: "W-1",
        kind: "task",
        title: "Add feature file",
        description: "Create feature.txt",
        acceptanceCriteria: ["feature.txt contains delivered"],
        allowedRoles: ["implementation", "review", "testing"],
        codeScopes: ["feature.txt"],
      },
      context(command.revision, "add-work"),
    );
    for (const agent of [
      profile("implementer", "implementation"),
      profile("reviewer", "review"),
      profile("tester", "testing"),
    ]) {
      command = repository.registerAgent(
        "p-1",
        agent,
        context(command.revision, `register-${agent.agentId}`),
      );
    }

    const adapters = new AgentAdapterRegistry();
    adapters.register(new DeliveryFixtureAdapter());
    const runs = new RunCoordinator({
      repository,
      adapters,
      worktreeRoot: () => join(sandbox, "worktrees"),
    });
    const director = new Director({ repository, runs });
    const result = await director.deliverWorkItem({ projectId: "p-1", workItemId: "W-1" });

    assert.equal(result.status, "done");
    assert.deepEqual(result.stages.map((stage) => stage.role), ["implementation", "review", "testing"]);
    assert.match(result.merge?.commitSha ?? "", /^[a-f0-9]{40}$/);
    assert.equal(readFileSync(join(repositoryPath, "feature.txt"), "utf8").replace(/\r\n/g, "\n"), "delivered\n");
    const final = repository.load("p-1").state;
    assert.equal(final.workItems["W-1"]?.ownStatus, "done");
    assert.equal(Object.values(final.evidence).filter((entry) => !entry.imported).length, 3);
    assert.equal(Object.values(final.decisions).length, 0);
    assert.equal(Object.values(final.artifacts).some((artifact) => artifact.kind === "commit"), true);
  } finally {
    store.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

class DeliveryFixtureAdapter implements AgentAdapter {
  readonly kind = "external" as const;
  readonly displayName = "Delivery Fixture";
  readonly executable = process.execPath;

  buildLaunchSpec(request: AgentLaunchRequest): AgentLaunchSpec {
    const isImplementation = request.prompt.startsWith("[implementation]");
    const script = isImplementation
      ? "require('node:fs').writeFileSync('feature.txt','delivered\\n');console.log(JSON.stringify({type:'ok'}))"
      : "console.log(JSON.stringify({type:'ok',message:'STREW_VERDICT: PASS'}))";
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
    const body = JSON.parse(line) as { message?: string };
    return [{ type: "provider.event", providerEventType: "fixture", message: body.message, raw: body }];
  }
}

function profile(agentId: string, role: "implementation" | "review" | "testing") {
  return {
    agentId,
    displayName: agentId,
    adapterKind: "external" as const,
    capabilities: [],
    roles: [role],
    reliability: 1,
    costPerMillionTokens: null,
    active: true,
    maxConcurrentRuns: 1,
    createdAt: new Date().toISOString(),
  };
}

function context(expectedRevision: number, idempotencyKey: string) {
  return { expectedRevision, idempotencyKey, actorType: "user" as const, actorId: "test" };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
