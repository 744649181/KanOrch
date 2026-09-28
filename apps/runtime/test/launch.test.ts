import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("headless entry serves the built director on a local port", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "kanorch-launch-"));
  const child = spawn(process.execPath, [resolve("apps/runtime/src/main.ts")], {
    cwd: resolve("."),
    env: { ...process.env, KANORCH_DATA_DIR: dataDirectory, KANORCH_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const baseUrl = await new Promise<string>((resolveUrl, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("server startup timed out")), 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (url) {
          clearTimeout(timer);
          resolveUrl(url);
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`server exited before ready: ${code}`)));
    });
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    const duplicate = spawnSync(process.execPath, [resolve("apps/runtime/src/main.ts")], {
      cwd: resolve("."),
      env: { ...process.env, KANORCH_DATA_DIR: dataDirectory, KANORCH_PORT: "0" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already running/);
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<div id="root"><\/div>/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    }
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
