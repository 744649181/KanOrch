import assert from "node:assert/strict";
import test from "node:test";

import { projectPresence } from "../src/project-presence.ts";
import type { ProjectView } from "../src/api.ts";

test("selected project is shown as the foreground workspace", () => {
  const project = projectView("alpha");
  assert.deepEqual(projectPresence(project, "alpha", new Set()), {
    kind: "foreground",
    label: "当前前台",
  });
});

test("non-selected project with an active run remains visible in background", () => {
  const project = projectView("alpha", "running");
  assert.deepEqual(projectPresence(project, "beta", new Set()), {
    kind: "background",
    label: "后台运行 · 1 项",
  });
});

test("non-selected idle project is retained in standby", () => {
  const project = projectView("alpha");
  assert.deepEqual(projectPresence(project, "beta", new Set()), {
    kind: "standby",
    label: "待命 · 状态已保留",
  });
});

function projectView(projectId: string, runStatus?: string): ProjectView {
  return {
    revision: 1,
    state: {
      project: { projectId, name: projectId },
      runs: runStatus ? { run: { status: runStatus } } : {},
    },
  } as unknown as ProjectView;
}
