import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultAdapterRegistry } from "../src/index.ts";

const request = {
  runId: "run-1",
  prompt: "Implement the assigned task",
  workspacePath: "C:/workspace/strew-task",
  permissionMode: "workspace-auto" as const,
};

test("default registry exposes the three requested CLI adapters", () => {
  const registry = createDefaultAdapterRegistry();
  assert.deepEqual(
    registry.list().map((adapter) => adapter.kind),
    ["claude-code", "codex", "opencode"],
  );
});

test("Codex uses workspace sandboxing without dangerous bypass flags", () => {
  const spec = createDefaultAdapterRegistry().buildLaunchSpec("codex", request);
  assert.deepEqual(spec.args.slice(0, 4), ["exec", "--json", "--cd", request.workspacePath]);
  assert.ok(spec.args.includes("--approve-for-me"));
  assert.ok(!spec.args.includes("--sandbox"));
  assert.ok(!spec.args.some((arg) => arg.includes("dangerously-bypass")));
  assert.equal(spec.stdin, `${request.prompt}\n`);

  const manual = createDefaultAdapterRegistry().buildLaunchSpec("codex", { ...request, permissionMode: "manual" });
  assert.ok(manual.args.includes("--sandbox"));
  assert.ok(manual.args.includes("workspace-write"));
  assert.ok(!manual.args.includes("--approve-for-me"));
});

test("Claude Code streams JSON with bounded non-bypass permissions", () => {
  const spec = createDefaultAdapterRegistry().buildLaunchSpec("claude-code", {
    ...request,
    maxBudgetUsd: 2.5,
  });
  assert.ok(spec.args.includes("stream-json"));
  assert.ok(spec.args.includes("--verbose"));
  assert.ok(spec.args.includes("auto"));
  assert.ok(spec.args.includes("2.5"));
  assert.ok(!spec.args.includes("--dangerously-skip-permissions"));
});

test("OpenCode scopes writes to its approval policy without enabling auto approval", () => {
  const registry = createDefaultAdapterRegistry();
  const normal = registry.buildLaunchSpec("opencode", request);
  assert.ok(!normal.args.includes("--auto"));
  assert.deepEqual(normal.args.slice(5, 7), ["--agent", "build"]);
  const config = JSON.parse(normal.environment.OPENCODE_CONFIG_CONTENT ?? "") as {
    permission: Record<string, unknown>;
    agent: { build: { permission: Record<string, unknown> } };
  };
  assert.equal(config.permission.edit, "allow");
  assert.equal(config.permission.bash, "ask");
  assert.equal(config.permission.webfetch, "ask");
  assert.equal(config.permission.task, "deny");
  assert.equal(config.permission.external_directory, "deny");
  assert.deepEqual(config.agent.build.permission, config.permission);
  const manual = registry.buildLaunchSpec("opencode", { ...request, permissionMode: "manual" });
  assert.equal(JSON.parse(manual.environment.OPENCODE_CONFIG_CONTENT ?? "").permission.edit, "ask");
  assert.throws(() => registry.buildLaunchSpec("opencode", { ...request, permissionMode: "external-sandbox-auto" }), /disabled/);
  const inherited = registry.buildLaunchSpec("opencode", {
    ...request, extraEnvironment: { OPENCODE_CONFIG_CONTENT: '{"theme":"dark","permission":"allow"}' },
  });
  assert.equal(JSON.parse(inherited.environment.OPENCODE_CONFIG_CONTENT ?? "").theme, "dark");
  assert.equal(JSON.parse(inherited.environment.OPENCODE_CONFIG_CONTENT ?? "").permission.external_directory, "deny");
});

test("provider parsers preserve unknown JSON while normalizing known events", () => {
  const registry = createDefaultAdapterRegistry();
  const codex = registry.get("codex");
  assert.equal(
    codex.parseStdoutLine('{"type":"thread.started","thread_id":"th-1"}')[0]?.type,
    "session.discovered",
  );
  assert.equal(codex.parseStdoutLine('{"type":"future.event","value":1}')[0]?.type, "provider.event");
  assert.equal(
    codex.parseStdoutLine('{"type":"item.completed","item":{"type":"agent_message","text":"STREW_VERDICT: PASS"}}')[0]?.message,
    "STREW_VERDICT: PASS",
  );
  assert.equal(codex.parseStdoutLine("plain output")[0]?.type, "output.delta");
  const openCodeUsage = registry
    .get("opencode")
    .parseStdoutLine('{"type":"step.finish","usage":{"input":12,"output":5},"cost":0.01}')[0];
  assert.equal(openCodeUsage?.type, "usage.updated");
  assert.equal(openCodeUsage?.inputTokens, 12);
  assert.equal(openCodeUsage?.outputTokens, 5);
  const realOpenCodeUsage = registry.get("opencode").parseStdoutLine(
    '{"type":"step_finish","part":{"type":"step-finish","tokens":{"input":288,"output":76,"cache":{"read":20,"write":3}},"cost":0}}',
  )[0];
  assert.equal(realOpenCodeUsage?.type, "usage.updated");
  assert.equal(realOpenCodeUsage?.inputTokens, 311);
  assert.equal(realOpenCodeUsage?.outputTokens, 76);
  assert.equal(realOpenCodeUsage?.costUsd, 0);
  const realOpenCodeTool = registry.get("opencode").parseStdoutLine(
    '{"type":"tool_use","part":{"type":"tool","tool":"write","callID":"call-1","state":{"status":"completed"}}}',
  )[0];
  assert.equal(realOpenCodeTool?.type, "tool.finished");
  assert.equal(realOpenCodeTool?.toolName, "write");
  assert.equal(realOpenCodeTool?.toolCallId, "call-1");
});
