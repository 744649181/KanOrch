import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import WebSocket from "ws";

import { LocalArtifactStore } from "../../../packages/artifact-store/src/index.ts";
import { StrewApplication } from "../src/application.ts";
import { startRuntimeServer } from "../src/server.ts";
import { initialPromptArgs } from "../src/terminal-sessions.ts";

test("interactive CLI arguments carry one initial task prompt", () => {
  assert.deepEqual(initialPromptArgs("codex", "task"), ["task"]);
  assert.deepEqual(initialPromptArgs("claude-code", "task"), ["task"]);
  assert.deepEqual(initialPromptArgs("opencode", "task"), ["--agent", "build", "--prompt", "task"]);
});

test("interactive terminal uses an isolated worktree and survives browser reconnect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kanorch-terminal-"));
  const repositoryPath = join(directory, "repository");
  git(directory, ["init", repositoryPath]);
  git(repositoryPath, ["config", "user.email", "kanorch@example.invalid"]);
  git(repositoryPath, ["config", "user.name", "KanOrch Test"]);
  writeFileSync(join(repositoryPath, "README.md"), "base\n");
  git(repositoryPath, ["add", "README.md"]);
  git(repositoryPath, ["commit", "-m", "Base"]);

  const script = [
    "process.stdin.setEncoding('utf8');",
    "process.stdout.write('READY TERM=' + process.env.TERM + ' HERDR=' + (process.env.HERDR_ENV ?? '') + ' OC=' + (process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).permission.external_directory : '') + ' INBOX=' + Boolean(process.env.KANORCH_INBOX_TOKEN) + ' ARGS=' + JSON.stringify(process.argv.slice(1)) + '\\n');",
    "if (process.env.KANORCH_INBOX_TOKEN) {",
    "const headers = { authorization: 'Bearer ' + process.env.KANORCH_INBOX_TOKEN };",
    "const base = process.env.KANORCH_INBOX_ORIGIN + '/api/agent/inbox';",
    "void fetch(base, {headers}).then(r => r.json()).then(body => Promise.all(body.handoffs.map(async message => {",
    "for (const artifactId of message.artifactIds) { const content = await (await fetch(base + '/' + message.messageId + '/artifacts/' + artifactId, {headers})).text(); if (content !== 'terminal handoff report') throw Error('wrong artifact'); }",
    "const response = await fetch(base + '/' + message.messageId + '/ack', {method:'POST',headers}); if (!response.ok) throw Error('ack failed: ' + response.status); return message.messageId;",
    "}))).then(ids => process.stdout.write('INBOX_ACK=' + ids.join(',') + '\\n')).catch(error => process.stdout.write('INBOX_ERROR=' + error.message + '\\n'));",
    "}",
    "process.stdin.on('data', data => { if (data.includes('ping')) process.stdout.write('PONG\\n'); });",
  ].join("");
  const inheritedHerdr = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  const application = new StrewApplication(join(directory, "kanorch.db"), {
    terminalLaunch: () => ({ executable: process.execPath, args: ["-e", script, "--"] }),
  });
  let current = application.createProject({
    projectId: "p-1", name: "Terminal test", repositoryPath, goal: "Use an owned PTY",
  }, context(0, "create"));
  current = application.addWorkItem("p-1", {
    workItemId: "W-1", kind: "task", title: "Interactive work",
    description: "Run and reconnect a terminal", acceptanceCriteria: ["Terminal output survives reconnect"],
    codeScopes: ["src/a"],
  }, context(current.revision, "add"));
  current = application.addWorkItem("p-1", {
    workItemId: "W-2", kind: "task", title: "Parallel work",
    description: "Run another terminal", acceptanceCriteria: ["Both terminals remain independent"],
    codeScopes: ["src/b"],
  }, context(current.revision, "add-second"));
  current = application.registerAgent("p-1", {
    agentId: "fixture", displayName: "Fixture", adapterKind: "external", capabilities: [],
    roles: ["implementation"], reliability: 1, costPerMillionTokens: null,
    active: true, maxConcurrentRuns: 1, createdAt: new Date().toISOString(),
  }, context(current.revision, "register"));
  current = application.registerAgent("p-1", {
    agentId: "fixture-2", displayName: "Fixture 2", adapterKind: "opencode", capabilities: [],
    roles: ["implementation"], reliability: 1, costPerMillionTokens: null,
    active: true, maxConcurrentRuns: 1, createdAt: new Date().toISOString(),
  }, context(current.revision, "register-second"));
  current = application.changeWorkItemStatus("p-1", "W-1", "ready", context(current.revision, "ready"));
  current = application.changeWorkItemStatus("p-1", "W-2", "ready", context(current.revision, "ready-second"));
  current = application.projects.startAgentRun("p-1", {
    runId: "source-run", workItemId: "W-2", agentId: "fixture", role: "implementation",
    attempt: 1, delegationDepth: 0, worktreePath: repositoryPath, branchName: "fixture/source",
  }, context(current.revision, "source-run"));
  current = application.projects.finishAgentRun("p-1", "source-run", "cancelled", context(current.revision, "source-finished"));
  const attachment = await new LocalArtifactStore(repositoryPath).write({
    projectId: "p-1", workItemId: "W-2", runId: "source-run", kind: "report",
    content: "terminal handoff report", mediaType: "text/plain",
  });
  current = application.projects.recordArtifact("p-1", attachment, context(current.revision, "source-artifact"));
  current = application.recordAgentHandoff("p-1", {
    messageId: "handoff-1", workItemId: "W-2", sourceRunId: "source-run",
    recipientAgentId: "fixture-2", kind: "handoff", summary: "Inspect the boundary", artifactIds: [attachment.artifactId],
  }, context(current.revision, "record-handoff"));

  const runtime = await startRuntimeServer(application, { port: 0 });
  let first: WebSocket | null = null;
  let second: WebSocket | null = null;
  let parallel: WebSocket | null = null;
  try {
    const base = `http://${runtime.host}:${runtime.port}`;
    assert.equal((await fetch(`${base}/api/health`, { headers: { origin: "http://evil.test" } })).status, 403);
    const terminalUrl = `${base}/api/projects/p-1/work-items/W-1/terminals`;
    const requestBody = JSON.stringify({ expectedRevision: current.revision, idempotencyKey: "start-terminal",
      agentId: "fixture", role: "implementation", cols: 80, rows: 24 });
    const response = await fetch(terminalUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: requestBody,
    });
    assert.equal(response.status, 201);
    const started = (await response.json()) as { terminal: { runId: string; worktreePath: string } };
    assert.ok(existsSync(started.terminal.worktreePath));
    assert.notEqual(started.terminal.worktreePath, repositoryPath);
    assert.equal(application.getProject("p-1")?.state.runs[started.terminal.runId]?.mode, "terminal");
    await waitFor(() => application.terminals.get("p-1", started.terminal.runId)?.output.includes("TERM=xterm-256color") ?? false);
    assert.equal(application.terminals.get("p-1", started.terminal.runId)?.output.includes("HERDR=1"), false);
    const repeated = await fetch(terminalUrl, { method: "POST", headers: { "content-type": "application/json" }, body: requestBody });
    assert.equal(repeated.status, 201);
    assert.equal(((await repeated.json()) as { terminal: { runId: string } }).terminal.runId, started.terminal.runId);

    const parallelResponse = await fetch(`${base}/api/projects/p-1/work-items/W-2/terminals`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: application.getProject("p-1")?.revision,
        idempotencyKey: "start-parallel", agentId: "fixture-2", role: "implementation", cols: 80, rows: 24 }),
    });
    assert.equal(parallelResponse.status, 201);
    const parallelRun = (await parallelResponse.json()) as { terminal: { runId: string; worktreePath: string } };
    assert.notEqual(parallelRun.terminal.worktreePath, started.terminal.worktreePath);
    assert.ok(existsSync(parallelRun.terminal.worktreePath));
    await waitFor(() => application.terminals.get("p-1", parallelRun.terminal.runId)?.output.includes("Inspect the boundary") ?? false);
    const launchedPrompt = application.terminals.get("p-1", parallelRun.terminal.runId)?.output ?? "";
    assert.match(launchedPrompt, /Work item W-2: Parallel work/);
    assert.match(launchedPrompt, /Both terminals remain independent/);
    assert.match(launchedPrompt, /Allowed code scopes: src\/b/);
    assert.match(launchedPrompt, /KanOrch handoffs for this agent and work item/);
    assert.match(launchedPrompt, /OC=deny/);
    assert.match(launchedPrompt, /INBOX=true/);
    assert.match(launchedPrompt, /KanOrch inbox:/);
    assert.match(launchedPrompt, /--agent","build/);
    await waitFor(() => application.getProject("p-1")?.state.handoffs["handoff-1"]?.acknowledgedByRunId === parallelRun.terminal.runId);
    await waitFor(() => application.terminals.get("p-1", parallelRun.terminal.runId)?.output.includes("INBOX_ACK=handoff-1") ?? false);
    assert.match(application.terminals.get("p-1", parallelRun.terminal.runId)?.output ?? "", /INBOX_ACK=handoff-1/);
    assert.ok(application.getProject("p-1")?.state.handoffs["handoff-1"]?.artifactReads?.[parallelRun.terminal.runId]?.[attachment.artifactId]);

    const url = `ws://${runtime.host}:${runtime.port}/api/projects/p-1/terminals/${started.terminal.runId}/stream`;
    const firstMessages: Array<{ type: string; data?: string }> = [];
    first = await connect(url, firstMessages);
    await waitFor(() => firstMessages.some((message) => message.type === "snapshot"));
    first.send(JSON.stringify({ type: "resize", cols: 90, rows: 30 }));
    first.send(JSON.stringify({ type: "input", data: "ping\r" }));
    await waitFor(() => application.terminals.get("p-1", started.terminal.runId)?.output.includes("PONG") ?? false);
    first.close();

    const secondMessages: Array<{ type: string; data?: string }> = [];
    second = await connect(url, secondMessages);
    await waitFor(() => secondMessages.some((message) => message.type === "snapshot" && message.data?.includes("PONG")));
    parallel = await connect(`ws://${runtime.host}:${runtime.port}/api/projects/p-1/terminals/${parallelRun.terminal.runId}/stream`, []);
    second.send(JSON.stringify({ type: "stop" }));
    await waitFor(() => application.getProject("p-1")?.state.runs[started.terminal.runId]?.status === "cancelled");
    assert.equal(application.getProject("p-1")?.state.runs[parallelRun.terminal.runId]?.status, "running");
    parallel.send(JSON.stringify({ type: "input", data: "ping\r" }));
    await waitFor(() => application.terminals.get("p-1", parallelRun.terminal.runId)?.output.includes("PONG") ?? false);
    parallel.send(JSON.stringify({ type: "stop" }));
    await waitFor(() => application.getProject("p-1")?.state.runs[parallelRun.terminal.runId]?.status === "cancelled");
    const state = application.getProject("p-1")?.state;
    assert.equal(state?.workspaceLeases[`lease-${started.terminal.runId}`]?.status, "released");
    assert.equal(state?.workspaceLeases[`lease-${parallelRun.terminal.runId}`]?.status, "released");
    assert.equal(application.getRunEvents("p-1", started.terminal.runId)?.some((event) =>
      (event.payload as { message?: string }).message?.includes("PONG")), true);
  } finally {
    first?.close();
    second?.close();
    parallel?.close();
    await runtime.close();
    application.close();
    if (inheritedHerdr === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = inheritedHerdr;
    rmSync(directory, { recursive: true, force: true });
  }
});

function context(expectedRevision: number, idempotencyKey: string) {
  return { expectedRevision, idempotencyKey, actorType: "user" as const, actorId: "test" };
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

async function connect(url: string, messages: Array<{ type: string; data?: string }>): Promise<WebSocket> {
  const socket = new WebSocket(url);
  socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as { type: string; data?: string }));
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return socket;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for terminal state");
}
