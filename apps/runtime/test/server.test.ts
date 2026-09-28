import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import WebSocket from "ws";

import { LocalArtifactStore } from "../../../packages/artifact-store/src/index.ts";
import { StrewApplication } from "../src/application.ts";
import { ensureProjectRepository } from "../src/repository-preflight.ts";
import { startRuntimeServer } from "../src/server.ts";

test("runtime persists commands and streams ordered events from a cursor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "strew-create-api-"));
  const repositoryPath = join(directory, "new-project");
  const application = new StrewApplication(":memory:");
  const runtime = await startRuntimeServer(application, { port: 0 });
  const baseUrl = `http://${runtime.host}:${runtime.port}`;
  try {
    const socket = new WebSocket(`ws://${runtime.host}:${runtime.port}/api/events?projectId=p-1&after=0`);
    const messages: unknown[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as unknown));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    const response = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "create-p-1",
        project: {
          projectId: "p-1",
          name: "Strew",
          repositoryPath,
          goal: "Direct multiple agents",
        },
      }),
    });
    assert.equal(response.status, 201);
    const created = (await response.json()) as { revision: number };
    assert.equal(created.revision, 1);
    assert.equal(gitCommand(repositoryPath, ["rev-parse", "--is-inside-work-tree"]), "true");
    assert.equal(gitCommand(repositoryPath, ["branch", "--show-current"]), "main");
    assert.notEqual(gitCommand(repositoryPath, ["rev-parse", "HEAD"]), "");

    await waitFor(() => messages.some((message) => isEventMessage(message)));
    const event = messages.find((message) => isEventMessage(message)) as {
      type: "event";
      event: { sequence: number; eventType: string };
    };
    assert.equal(event.event.sequence, 1);
    assert.equal(event.event.eventType, "project.created");

    const projectResponse = await fetch(`${baseUrl}/api/projects/p-1`);
    assert.equal(projectResponse.status, 200);
    const project = (await projectResponse.json()) as { state: { project: { name: string } } };
    assert.equal(project.state.project.name, "Strew");
    const added = await fetch(`${baseUrl}/api/projects/p-1/work-items`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, idempotencyKey: "add-w-1",
        workItem: { workItemId: "W-1", kind: "task", title: "Task", description: "Check roles", acceptanceCriteria: ["Reviewed"] } }),
    });
    assert.equal(added.status, 201);
    const revised = await fetch(`${baseUrl}/api/projects/p-1/work-items/W-1/roles`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 2, idempotencyKey: "roles-w-1", allowedRoles: ["implementation", "review", "testing"] }),
    });
    assert.equal(revised.status, 200);
    const revisedProject = (await revised.json()) as { revision: number; state: { workItems: Record<string, { allowedRoles: string[] }> } };
    assert.deepEqual(revisedProject.state.workItems["W-1"]?.allowedRoles,
      ["implementation", "review", "testing"]);
    const unverifiedMerge = await fetch(`${baseUrl}/api/projects/p-1/work-items/W-1/integrate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: revisedProject.revision, idempotencyKey: "integrate-w-1", implementationRunId: "missing" }),
    });
    assert.equal(unverifiedMerge.status, 409);
    assert.match(((await unverifiedMerge.json()) as { message: string }).message, /successful implementation run/);
    assert.equal(gitCommand(repositoryPath, ["branch", "--show-current"]), "main");
    socket.close();
  } finally {
    await runtime.close();
    application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an empty unborn Git repository gets a base commit on its existing branch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kanorch-unborn-"));
  const repositoryPath = join(directory, "repository");
  mkdirSync(repositoryPath);
  gitCommand(repositoryPath, ["init", "-b", "master"]);
  try {
    const prepared = await ensureProjectRepository(repositoryPath, "master");
    assert.equal(prepared.initialized, true);
    assert.equal(gitCommand(repositoryPath, ["branch", "--show-current"]), "master");
    assert.notEqual(gitCommand(repositoryPath, ["rev-parse", "HEAD"]), "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unborn Git repository with user files remains untouched", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kanorch-unborn-files-"));
  const repositoryPath = join(directory, "repository");
  mkdirSync(repositoryPath);
  gitCommand(repositoryPath, ["init", "-b", "master"]);
  writeFileSync(join(repositoryPath, "README.md"), "user content\n");
  try {
    await assert.rejects(ensureProjectRepository(repositoryPath, "master"), /only when it is empty/);
    assert.equal(gitCommand(repositoryPath, ["status", "--porcelain"]), "?? README.md");
    assert.equal(gitCommand(repositoryPath, ["rev-list", "--count", "--all"]), "0");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("agent inbox requires a live run token and attachment retrieval before acknowledgement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kanorch-inbox-"));
  const repositoryPath = join(directory, "repository");
  mkdirSync(repositoryPath);
  gitCommand(repositoryPath, ["init", "-b", "main"]);
  const application = new StrewApplication(join(directory, "kanorch.db"));
  let runtime: Awaited<ReturnType<typeof startRuntimeServer>> | null = null;
  try {
    let result = application.createProject({ projectId: "p-inbox", name: "Inbox", repositoryPath, goal: "Verify handoffs" }, context(0, "inbox-project"));
    result = application.addWorkItem("p-inbox", { workItemId: "W-1", kind: "task", title: "Handoff", description: "Read attachment", acceptanceCriteria: ["Receipt persisted"] }, context(result.revision, "inbox-item"));
    for (const agentId of ["sender", "receiver"]) {
      result = application.registerAgent("p-inbox", {
        agentId, displayName: agentId, adapterKind: "external", capabilities: [], roles: ["implementation"],
        reliability: 1, costPerMillionTokens: null, active: true, maxConcurrentRuns: 1, createdAt: new Date().toISOString(),
      }, context(result.revision, `inbox-agent-${agentId}`));
    }
    result = application.changeWorkItemStatus("p-inbox", "W-1", "ready", context(result.revision, "inbox-ready"));
    result = application.projects.startAgentRun("p-inbox", {
      runId: "source", workItemId: "W-1", agentId: "sender", role: "implementation",
      attempt: 1, delegationDepth: 0, worktreePath: repositoryPath, branchName: "test/source",
    }, context(result.revision, "inbox-source"));
    const artifact = await new LocalArtifactStore(repositoryPath).write({
      projectId: "p-inbox", workItemId: "W-1", runId: "source", kind: "report",
      content: "handoff content", mediaType: "text/plain",
    });
    result = application.projects.recordArtifact("p-inbox", artifact, context(result.revision, "inbox-artifact"));
    result = application.projects.finishAgentRun("p-inbox", "source", "succeeded", context(result.revision, "inbox-source-end"));
    result = application.changeWorkItemStatus("p-inbox", "W-1", "ready", context(result.revision, "inbox-ready-again"));
    result = application.recordAgentHandoff("p-inbox", {
      messageId: "handoff-1", workItemId: "W-1", sourceRunId: "source", recipientAgentId: "receiver",
      kind: "handoff", summary: "Read the report", artifactIds: [artifact.artifactId],
    }, context(result.revision, "inbox-handoff"));
    result = application.projects.startAgentRun("p-inbox", {
      runId: "recipient", workItemId: "W-1", agentId: "receiver", role: "implementation",
      attempt: 1, delegationDepth: 0, worktreePath: repositoryPath, branchName: "test/recipient",
    }, context(result.revision, "inbox-recipient"));
    runtime = await startRuntimeServer(application, { port: 0 });
    const token = application.inbox.openRun("p-inbox", "recipient")?.KANORCH_INBOX_TOKEN;
    assert.ok(token);
    const base = `http://${runtime.host}:${runtime.port}/api/agent/inbox`;
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await fetch(base)).status, 401);
    const inbox = await (await fetch(base, { headers })).json() as { handoffs: Array<{ messageId: string }> };
    assert.deepEqual(inbox.handoffs.map((message) => message.messageId), ["handoff-1"]);
    const ackUrl = `${base}/handoff-1/ack`;
    assert.equal((await fetch(ackUrl, { method: "POST", headers })).status, 409);
    assert.equal((await fetch(`${base}/handoff-1/artifacts/other`, { headers })).status, 409);
    const artifactUrl = `${base}/handoff-1/artifacts/${artifact.artifactId}`;
    assert.equal(await (await fetch(artifactUrl, { headers })).text(), "handoff content");
    const revisionAfterFetch = application.getProject("p-inbox")?.revision;
    assert.equal(await (await fetch(artifactUrl, { headers })).text(), "handoff content");
    assert.equal(application.getProject("p-inbox")?.revision, revisionAfterFetch);
    assert.equal((await fetch(ackUrl, { method: "POST", headers })).status, 200);
    const revisionAfterAck = application.getProject("p-inbox")?.revision;
    assert.equal((await fetch(ackUrl, { method: "POST", headers })).status, 200);
    assert.equal(application.getProject("p-inbox")?.revision, revisionAfterAck);
    const handoff = application.getProject("p-inbox")?.state.handoffs["handoff-1"];
    assert.ok(handoff?.artifactReads?.recipient?.[artifact.artifactId]);
    assert.equal(handoff?.acknowledgedByRunId, "recipient");
    const live = application.getProject("p-inbox")!;
    application.recordAgentHandoff("p-inbox", {
      messageId: "handoff-late", workItemId: "W-1", sourceRunId: "source", recipientAgentId: "receiver",
      kind: "blocker", summary: "New information while running", artifactIds: [],
    }, context(live.revision, "inbox-late-handoff"));
    const updatedInbox = await (await fetch(base, { headers })).json() as { handoffs: Array<{ messageId: string }> };
    assert.deepEqual(updatedInbox.handoffs.map((message) => message.messageId), ["handoff-1", "handoff-late"]);
    assert.equal((await fetch(`${base}/handoff-late/ack`, { method: "POST", headers })).status, 200);
    application.inbox.closeRun("p-inbox", "recipient");
    assert.equal((await fetch(base, { headers })).status, 401);
    await runtime.close();
    runtime = null;
    application.close();
    const reopened = new StrewApplication(join(directory, "kanorch.db"));
    try {
      assert.equal(reopened.getProject("p-inbox")?.state.handoffs["handoff-1"]?.acknowledgedByRunId, "recipient");
      assert.equal(reopened.getProject("p-inbox")?.state.handoffs["handoff-late"]?.acknowledgedByRunId, "recipient");
    } finally {
      reopened.close();
    }
  } finally {
    if (runtime) await runtime.close();
    application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a live batch run can be cancelled through the local API", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kanorch-batch-cancel-"));
  const repositoryPath = join(directory, "repository");
  mkdirSync(repositoryPath);
  gitCommand(repositoryPath, ["init", "-b", "main"]);
  gitCommand(repositoryPath, ["-c", "user.name=KanOrch Test", "-c", "user.email=test@local.invalid", "commit", "--allow-empty", "-m", "Base"]);
  const application = new StrewApplication(join(directory, "kanorch.db"));
  application.adapters.register({
    kind: "external", displayName: "Waiting fixture", executable: process.execPath,
    buildLaunchSpec(request) {
      return { adapterKind: "external", executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: request.workspacePath, stdin: null, environment: {} };
    },
    parseStdoutLine(line) { return [{ type: "output.delta", message: line, raw: line }]; },
  });
  let runtime: Awaited<ReturnType<typeof startRuntimeServer>> | null = null;
  try {
    let result = application.createProject({ projectId: "p-cancel", name: "Cancel", repositoryPath, baseBranch: "main", goal: "Stop a stuck run" }, context(0, "cancel-project"));
    result = application.addWorkItem("p-cancel", { workItemId: "W-1", kind: "task", title: "Wait", description: "Wait for cancellation", acceptanceCriteria: ["Lease released"] }, context(result.revision, "cancel-item"));
    result = application.registerAgent("p-cancel", { agentId: "waiter", displayName: "Waiter", adapterKind: "external", capabilities: [], roles: ["implementation"], reliability: 1, costPerMillionTokens: null, active: true, maxConcurrentRuns: 1, createdAt: new Date().toISOString() }, context(result.revision, "cancel-agent"));
    application.changeWorkItemStatus("p-cancel", "W-1", "ready", context(result.revision, "cancel-ready"));
    runtime = await startRuntimeServer(application, { port: 0 });
    const pending = application.executeAgentRun({ projectId: "p-cancel", workItemId: "W-1", role: "implementation", agentId: "waiter", runId: "run-cancel", prompt: "Wait", permissionMode: "manual" });
    await waitFor(() => application.getProject("p-cancel")?.state.runs["run-cancel"]?.status === "running");
    const base = `http://${runtime.host}:${runtime.port}`;
    assert.equal((await fetch(`${base}/api/projects/wrong/runs/run-cancel/cancel`, { method: "POST" })).status, 409);
    assert.equal((await fetch(`${base}/api/projects/p-cancel/runs/run-cancel/cancel`, { method: "POST" })).status, 202);
    assert.equal((await pending).status, "cancelled");
    assert.equal(application.getProject("p-cancel")?.state.workspaceLeases["lease-run-cancel"]?.status, "released");
    assert.equal((await fetch(`${base}/api/projects/p-cancel/runs/run-cancel/cancel`, { method: "POST" })).status, 409);
    const current = application.getProject("p-cancel")!;
    if (current.state.workItems["W-1"]?.ownStatus !== "ready") {
      application.changeWorkItemStatus("p-cancel", "W-1", "ready", context(current.revision, "cancel-ready-again"));
    }
    const pendingShutdown = application.executeAgentRun({ projectId: "p-cancel", workItemId: "W-1", role: "implementation", agentId: "waiter", runId: "run-shutdown", prompt: "Wait", permissionMode: "manual" });
    await waitFor(() => application.getProject("p-cancel")?.state.runs["run-shutdown"]?.status === "running");
    await runtime.close();
    runtime = null;
    assert.equal((await pendingShutdown).status, "cancelled");
    assert.equal(application.getProject("p-cancel")?.state.workspaceLeases["lease-run-shutdown"]?.status, "released");
  } finally {
    if (runtime) await runtime.close();
    application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime records a directed handoff and rejects an unrelated artifact", async () => {
  const application = new StrewApplication(":memory:");
  let result = application.createProject({
    projectId: "handoff", name: "KanOrch", repositoryPath: "C:/fixture", goal: "Coordinate agents",
  }, context(0, "create-handoff"));
  result = application.addWorkItem("handoff", {
    workItemId: "W-1", kind: "task", title: "Build feature", description: "Implement and review",
    acceptanceCriteria: ["Reviewed result"],
  }, context(result.revision, "add-handoff-work"));
  for (const agentId of ["writer", "reviewer"]) {
    result = application.registerAgent("handoff", {
      agentId, displayName: agentId, adapterKind: "external", capabilities: [],
      roles: ["implementation", "review"], reliability: 1, costPerMillionTokens: null,
      active: true, maxConcurrentRuns: 1, createdAt: new Date().toISOString(),
    }, context(result.revision, `register-${agentId}`));
  }
  result = application.changeWorkItemStatus("handoff", "W-1", "ready", context(result.revision, "ready-handoff"));
  result = application.projects.startAgentRun("handoff", {
    runId: "writer-run", workItemId: "W-1", agentId: "writer", role: "implementation",
    attempt: 1, delegationDepth: 0, worktreePath: "C:/fixture-worktree", branchName: "fixture/work",
  }, context(result.revision, "start-writer"));
  const runtime = await startRuntimeServer(application, { port: 0 });
  try {
    const url = `http://${runtime.host}:${runtime.port}/api/projects/handoff/handoffs`;
    const handoff = {
      messageId: crypto.randomUUID(), workItemId: "W-1", sourceRunId: "writer-run",
      recipientAgentId: "reviewer", kind: "review_request", summary: "Check behavior", artifactIds: [],
    };
    const post = (revision: number, artifactIds: string[]) => fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: revision, idempotencyKey: crypto.randomUUID(), handoff: { ...handoff, artifactIds } }),
    });
    assert.equal((await post(result.revision, ["foreign-artifact"])).status, 409);
    const response = await post(result.revision, []);
    assert.equal(response.status, 201);
    const saved = (await response.json()) as { revision: number; state: { handoffs: Record<string, { summary: string }> } };
    assert.equal(saved.state.handoffs[handoff.messageId]?.summary, "Check behavior");
    const readBack = await fetch(`http://${runtime.host}:${runtime.port}/api/projects/handoff`);
    const project = (await readBack.json()) as { revision: number; state: { handoffs: Record<string, unknown> } };
    assert.equal(project.revision, saved.revision);
    assert.ok(project.state.handoffs[handoff.messageId]);
  } finally {
    await runtime.close();
    application.close();
  }
});

test("runtime turns a project goal into a validated persisted DAG", async () => {
  const directory = mkdtempSync(join(tmpdir(), "strew-auto-plan-api-"));
  const repositoryPath = join(directory, "new-project");
  const planOutput = `STREW_PLAN_JSON\n${JSON.stringify({
    version: 1,
    summary: "Ship the API safely",
    workItems: [
      {
        workItemId: "S-001",
        parentWorkItemId: null,
        kind: "task",
        title: "Define API",
        description: "Define the API contract.",
        acceptanceCriteria: ["Contract test exists"],
        requiredCapabilities: ["architecture"],
        codeScopes: ["src/api"],
      },
      {
        workItemId: "S-002",
        parentWorkItemId: null,
        kind: "test",
        title: "Verify API",
        description: "Run the API contract suite.",
        acceptanceCriteria: ["Contract suite passes"],
        requiredCapabilities: ["testing"],
        codeScopes: ["tests/api"],
      },
    ],
    dependencies: [{ upstreamWorkItemId: "S-001", downstreamWorkItemId: "S-002", kind: "blocks" }],
  })}\nSTREW_PLAN_END`;
  const application = new StrewApplication(":memory:", {
    planningRuns: {
      async execute(input) {
        return {
          runId: input.role === "planning" ? "plan-run" : "review-run",
          agentId: input.role === "planning" ? "codex" : "claude",
          status: "succeeded" as const,
          events: [{
            eventId: `${input.role}-output`,
            runId: input.role === "planning" ? "plan-run" : "review-run",
            sequence: 1,
            occurredAt: new Date().toISOString(),
            type: "output.delta" as const,
            message: input.role === "planning" ? planOutput : "STREW_VERDICT: PASS",
            raw: { planOutput },
          }],
        };
      },
    },
  });
  let created = application.createProject(
    { projectId: "auto-plan", name: "Auto plan", repositoryPath, goal: "Ship an API" },
    context(0, "create-auto-plan"),
  );
  for (const [agentId, adapterKind] of [["codex", "codex"], ["claude", "claude-code"]] as const) {
    created = application.registerAgent(
      "auto-plan",
      {
        agentId,
        displayName: agentId,
        adapterKind,
        capabilities: ["architecture", "testing"],
        roles: ["planning", "implementation", "review", "testing"],
        reliability: agentId === "codex" ? 1 : 0.9,
        costPerMillionTokens: null,
        active: true,
        maxConcurrentRuns: 1,
        createdAt: new Date().toISOString(),
      },
      context(created.revision, `register-${agentId}`),
    );
  }
  const runtime = await startRuntimeServer(application, { port: 0 });
  try {
    const response = await fetch(`http://${runtime.host}:${runtime.port}/api/projects/auto-plan/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: created.revision,
        idempotencyKey: "plan-auto",
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      status: string;
      project: { state: { workItems: Record<string, { ownStatus: string }>; dependencies: Record<string, unknown> } };
    };
    assert.equal(body.status, "planned");
    assert.equal(body.project.state.workItems["STREW-PLAN"]?.ownStatus, "done");
    assert.equal(body.project.state.workItems["S-001"]?.ownStatus, "ready");
    assert.equal(body.project.state.workItems["S-002"]?.ownStatus, "backlog");
    assert.equal(Object.keys(body.project.state.dependencies).length, 1);
  } finally {
    await runtime.close();
    application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime rejects a non-empty non-Git project without committing unknown files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "strew-non-git-api-"));
  const repositoryPath = join(directory, "existing-files");
  const application = new StrewApplication(":memory:");
  const runtime = await startRuntimeServer(application, { port: 0 });
  try {
    mkdirSync(repositoryPath);
    writeFileSync(join(repositoryPath, "secret.env"), "DO_NOT_COMMIT=1\n", "utf8");
    const response = await fetch(`http://${runtime.host}:${runtime.port}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "create-non-git",
        project: {
          projectId: "non-git",
          name: "Non Git",
          repositoryPath,
          baseBranch: "main",
          goal: "Do not commit unknown files",
        },
      }),
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { message?: string };
    assert.match(body.message ?? "", /only auto-initializes empty directories/);
    assert.equal(existsSync(join(repositoryPath, ".git")), false);
  } finally {
    await runtime.close();
    application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime serves the built web application without exposing parent paths", async () => {
  const directory = mkdtempSync(join(tmpdir(), "strew-static-"));
  writeFileSync(join(directory, "index.html"), "<main>Strew</main>", "utf8");
  const application = new StrewApplication(":memory:");
  const runtime = await startRuntimeServer(application, { port: 0, staticRoot: directory });
  try {
    const response = await fetch(`http://${runtime.host}:${runtime.port}/`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<main>Strew</main>");
    const traversal = await fetch(`http://${runtime.host}:${runtime.port}/..%2Fsecret.txt`);
    assert.equal(traversal.status, 400);
  } finally {
    await runtime.close();
    application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime recovery cancels interrupted runs, releases leases, and raises a decision", () => {
  const directory = mkdtempSync(join(tmpdir(), "strew-recovery-"));
  const databasePath = join(directory, "strew.sqlite");
  let application = new StrewApplication(databasePath);
  try {
    let command = application.projects.createProject(
      {
        projectId: "recover",
        name: "Recovery",
        repositoryPath: "C:/workspace/recovery",
        goal: "Recover safely",
      },
      context(0, "create-recovery"),
    );
    command = application.projects.addWorkItem(
      "recover",
      {
        workItemId: "W-1",
        kind: "task",
        title: "Interrupted task",
        description: "Simulate a runtime stop",
        acceptanceCriteria: ["Recovery is auditable"],
        allowedRoles: ["implementation"],
      },
      context(command.revision, "add-recovery-work"),
    );
    command = application.projects.registerAgent(
      "recover",
      {
        agentId: "codex",
        displayName: "Codex",
        adapterKind: "codex",
        capabilities: [],
        roles: ["implementation"],
        reliability: 1,
        costPerMillionTokens: null,
        active: true,
        maxConcurrentRuns: 1,
        createdAt: new Date().toISOString(),
      },
      context(command.revision, "register-recovery-agent"),
    );
    command = application.projects.changeWorkItemStatus(
      "recover",
      "W-1",
      "ready",
      context(command.revision, "ready-recovery"),
    );
    application.projects.startAgentRunWithLease(
      "recover",
      {
        runId: "run-interrupted",
        workItemId: "W-1",
        agentId: "codex",
        role: "implementation",
        attempt: 1,
        delegationDepth: 0,
        worktreePath: "C:/worktrees/interrupted",
        branchName: "strew/interrupted",
      },
      {
        leaseId: "lease-interrupted",
        workItemId: "W-1",
        runId: "run-interrupted",
        worktreePath: "C:/worktrees/interrupted",
        branchName: "strew/interrupted",
      },
      context(command.revision, "start-interrupted"),
    );
    application.close();

    application = new StrewApplication(databasePath);
    const recovered = application.getProject("recover")?.state;
    assert.equal(recovered?.runs["run-interrupted"]?.status, "cancelled");
    assert.equal(recovered?.workspaceLeases["lease-interrupted"]?.status, "released");
    assert.equal(recovered?.workItems["W-1"]?.ownStatus, "blocked");
    assert.equal(Object.values(recovered?.decisions ?? {}).some((decision) => decision.status === "pending"), true);
  } finally {
    application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime imports a K-now board through the local API without upgrading historical evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "strew-import-api-"));
  const sourcePath = join(directory, "legacy.json");
  writeFileSync(sourcePath, JSON.stringify({
    schema_version: 2,
    board_id: "legacy",
    goal: "Legacy",
    revision: 4,
    models: {},
    cards: {
      "L-1": {
        card_id: "L-1",
        title: "Legacy card",
        description: "Imported only as history",
        required_capabilities: [],
        allowed_roles: ["implementation"],
        acceptance_criteria: ["Historical"],
        column: "done",
        created_at: "2026-08-23T09:36:08.838166Z",
      },
    },
    evidence: [],
  }), "utf8");
  const application = new StrewApplication(":memory:");
  const created = application.createProject(
    {
      projectId: "import-project",
      name: "Import",
      repositoryPath: directory,
      goal: "Import safely",
    },
    context(0, "create-import-project"),
  );
  const runtime = await startRuntimeServer(application, { port: 0 });
  try {
    const response = await fetch(
      `http://${runtime.host}:${runtime.port}/api/projects/import-project/imports/k-now`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: created.revision,
          idempotencyKey: "import-legacy",
          sourcePath,
        }),
      },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { state: { workItems: Record<string, { origin: string }> } };
    assert.equal(body.state.workItems["L-1"]?.origin, "k-now");
  } finally {
    await runtime.close();
    application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workspace lease conflicts create a persisted decision before an agent process starts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "strew-conflict-"));
  const repositoryPath = join(directory, "repository");
  gitCommand(directory, ["init", "-b", "main", repositoryPath]);
  gitCommand(repositoryPath, ["config", "user.email", "strew@example.invalid"]);
  gitCommand(repositoryPath, ["config", "user.name", "Strew Test"]);
  writeFileSync(join(repositoryPath, "README.md"), "base\n", "utf8");
  gitCommand(repositoryPath, ["add", "README.md"]);
  gitCommand(repositoryPath, ["commit", "-m", "Base"]);
  const application = new StrewApplication(":memory:");
  try {
    let command = application.projects.createProject(
      { projectId: "conflict", name: "Conflict", repositoryPath, baseBranch: "main", goal: "Protect writers" },
      context(0, "create-conflict"),
    );
    for (const workItemId of ["W-1", "W-2"]) {
      command = application.projects.addWorkItem(
        "conflict",
        {
          workItemId,
          kind: "task",
          title: workItemId,
          description: "Overlapping work",
          acceptanceCriteria: ["No concurrent writer"],
          allowedRoles: ["implementation"],
          codeScopes: workItemId === "W-1" ? ["src/runtime"] : ["src/runtime/server"],
        },
        context(command.revision, `add-${workItemId}`),
      );
    }
    command = application.projects.registerAgent(
      "conflict",
      {
        agentId: "codex",
        displayName: "Codex",
        adapterKind: "codex",
        capabilities: [],
        roles: ["implementation"],
        reliability: 1,
        costPerMillionTokens: null,
        active: true,
        maxConcurrentRuns: 2,
        createdAt: new Date().toISOString(),
      },
      context(command.revision, "register-conflict-agent"),
    );
    command = application.projects.changeWorkItemStatus("conflict", "W-1", "ready", context(command.revision, "ready-W-1"));
    command = application.projects.startAgentRunWithLease(
      "conflict",
      {
        runId: "run-writer",
        workItemId: "W-1",
        agentId: "codex",
        role: "implementation",
        attempt: 1,
        delegationDepth: 0,
        worktreePath: join(directory, "existing-writer"),
        branchName: "strew/existing-writer",
      },
      {
        leaseId: "lease-writer",
        workItemId: "W-1",
        runId: "run-writer",
        worktreePath: join(directory, "existing-writer"),
        branchName: "strew/existing-writer",
        codeScopes: ["src/runtime"],
      },
      context(command.revision, "start-writer"),
    );
    command = application.projects.changeWorkItemStatus("conflict", "W-2", "ready", context(command.revision, "ready-W-2"));
    await assert.rejects(
      application.executeAgentRun({
        projectId: "conflict",
        workItemId: "W-2",
        role: "implementation",
        prompt: "Do not start",
        permissionMode: "workspace-auto",
        agentId: "codex",
      }),
      /workspace lease conflicts/,
    );
    const state = application.getProject("conflict")?.state;
    assert.equal(Object.values(state?.decisions ?? {}).some((decision) => decision.trigger === "workspace_conflict"), true);
    assert.equal(state?.workItems["W-2"]?.ownStatus, "blocked");
  } finally {
    application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function isEventMessage(value: unknown): value is { type: "event"; event: unknown } {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "event";
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for runtime event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function context(expectedRevision: number, idempotencyKey: string) {
  return { expectedRevision, idempotencyKey, actorType: "user" as const, actorId: "test" };
}

function gitCommand(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
