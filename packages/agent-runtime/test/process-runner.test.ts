import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AdapterOutputEvent,
  AgentAdapter,
  AgentLaunchRequest,
  AgentLaunchSpec,
} from "../../agent-protocol/src/index.ts";
import { SqliteEventStore } from "../../event-store/src/index.ts";
import { AgentProcessError, AgentProcessRunner, RunEventRecorder, type RunStreamProjection } from "../src/index.ts";
import { resolveCliLaunch } from "../src/cli-launch.ts";

class NodeFixtureAdapter implements AgentAdapter {
  readonly kind = "external" as const;
  readonly displayName = "Node fixture";
  readonly executable = process.execPath;

  buildLaunchSpec(request: AgentLaunchRequest): AgentLaunchSpec {
    return {
      adapterKind: this.kind,
      executable: this.executable,
      args: [
        "-e",
        "console.log(JSON.stringify({type:'tool.start', tool:'test'})); console.error('diagnostic')",
      ],
      cwd: request.workspacePath,
      stdin: null,
      environment: {},
    };
  }

  parseStdoutLine(line: string): AdapterOutputEvent[] {
    const parsed = JSON.parse(line) as { type: string; tool: string };
    return [{ type: "tool.started", toolName: parsed.tool, providerEventType: parsed.type, raw: parsed }];
  }
}

test("process runner emits normalized output in order and persists the run stream", async () => {
  const store = new SqliteEventStore(":memory:");
  const recorder = new RunEventRecorder(store);
  const runner = new AgentProcessRunner();
  const result = await runner.run(
    new NodeFixtureAdapter(),
    {
      runId: "run-1",
      prompt: "fixture",
      workspacePath: process.cwd(),
      permissionMode: "manual",
    },
    {
      onEvent: (event) => {
        recorder.record(event);
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["run.started", "tool.started", "output.delta", "run.succeeded"],
  );
  assert.deepEqual(
    result.events.map((event) => event.sequence),
    [1, 2, 3, 4],
  );
  const stream = store.readStream("run:run-1");
  assert.equal(stream.length, 4);
  const snapshot = store.loadSnapshot<RunStreamProjection>("run:run-1");
  assert.equal(snapshot?.state.status, "succeeded");
  assert.equal(snapshot?.state.lastSequence, 4);
  store.close();
});

test("process startup failures are normalized and persisted before rejection", async () => {
  const store = new SqliteEventStore(":memory:");
  const recorder = new RunEventRecorder(store);
  const adapter: AgentAdapter = {
    kind: "external",
    displayName: "Missing executable",
    executable: "strew-executable-that-does-not-exist",
    buildLaunchSpec(request) {
      return {
        adapterKind: "external",
        executable: this.executable,
        args: [],
        cwd: request.workspacePath,
        stdin: null,
        environment: {},
      };
    },
    parseStdoutLine(line) {
      return [{ type: "output.delta", message: line, raw: line }];
    },
  };
  await assert.rejects(
    new AgentProcessRunner().run(
      adapter,
      {
        runId: "run-missing",
        prompt: "fixture",
        workspacePath: process.cwd(),
        permissionMode: "manual",
      },
      {
        onEvent(event) {
          recorder.record(event);
        },
      },
    ),
    AgentProcessError,
  );
  const stream = store.readStream("run:run-missing");
  assert.deepEqual(stream.map((event) => event.eventType), ["agent_run.run.started", "agent_run.run.failed"]);
  assert.equal(store.loadSnapshot<RunStreamProjection>("run:run-missing")?.state.status, "failed");
  store.close();
});

test("Windows CLI resolution prefers native executables and safely unwraps npm shims", {
  skip: process.platform !== "win32",
}, () => {
  const sandbox = mkdtempSync(join(tmpdir(), "strew-cli-launch-"));
  try {
    const nativeDirectory = join(sandbox, "native");
    const shimDirectory = join(sandbox, "shims");
    mkdirSync(nativeDirectory);
    mkdirSync(shimDirectory);
    const nativeExecutable = join(nativeDirectory, "codex.exe");
    writeFileSync(nativeExecutable, "fixture", "utf8");
    const native = resolveCliLaunch("codex", ["--version"], { Path: nativeDirectory }, "win32");
    assert.equal(native.executable, nativeExecutable);
    assert.deepEqual(native.args, ["--version"]);

    const script = join(shimDirectory, "node_modules", "fixture", "cli.js");
    mkdirSync(join(shimDirectory, "node_modules", "fixture"), { recursive: true });
    writeFileSync(script, "console.log('fixture')\n", "utf8");
    writeFileSync(
      join(shimDirectory, "claude.cmd"),
      '@ECHO off\r\n"%dp0%\\node_modules\\fixture\\cli.js" %*\r\n',
      "utf8",
    );
    const shimmed = resolveCliLaunch("claude", ["--version"], { PATH: shimDirectory }, "win32");
    assert.equal(shimmed.executable, process.execPath);
    assert.deepEqual(shimmed.args, [script, "--version"]);

    writeFileSync(
      join(shimDirectory, "codex.cmd"),
      '@ECHO off\r\n"%dp0%\\node_modules\\fixture\\cli.js" %*\r\n',
      "utf8",
    );
    const orderedPath = [shimDirectory, nativeDirectory].join(process.platform === "win32" ? ";" : ":");
    const pathOrdered = resolveCliLaunch("codex", ["--version"], { PATH: orderedPath }, "win32");
    assert.equal(pathOrdered.executable, process.execPath);
    assert.deepEqual(pathOrdered.args, [script, "--version"]);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
