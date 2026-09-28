import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StrewApplication } from "./application.ts";
import { startRuntimeServer } from "./server.ts";

const dataDirectory = resolve(process.env.KANORCH_DATA_DIR ?? process.env.STREW_DATA_DIR ?? ".strew");
const databasePath = resolve(dataDirectory, "strew.db");
const port = Number.parseInt(process.env.KANORCH_PORT ?? process.env.STREW_PORT ?? "4174", 10);
const staticRoot = resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const releaseDataDirectory = lockDataDirectory(dataDirectory);
process.once("exit", releaseDataDirectory);
const application = new StrewApplication(databasePath);
const runtime = await startRuntimeServer(application, { port, staticRoot });

process.stdout.write(`KanOrch runtime listening on http://${runtime.host}:${runtime.port}\n`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await runtime.close();
  application.close();
  releaseDataDirectory();
}

function shutdownAndExit(): void {
  void shutdown().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`KanOrch runtime shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}

process.once("SIGINT", shutdownAndExit);
process.once("SIGTERM", shutdownAndExit);

function lockDataDirectory(directory: string): () => void {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "kanorch.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = openSync(path, "wx");
      try { writeFileSync(file, String(process.pid)); } finally { closeSync(file); }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        unlinkSync(path);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: number;
      try {
        owner = Number(readFileSync(path, "utf8"));
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readError;
      }
      if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error(`KanOrch data directory is locked: ${directory}`);
      try {
        process.kill(owner, 0);
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") throw probeError;
        unlinkSync(path);
        continue;
      }
      throw new Error(`KanOrch is already running with data directory ${directory} (PID ${owner})`);
    }
  }
  throw new Error(`KanOrch data directory is locked: ${directory}`);
}
