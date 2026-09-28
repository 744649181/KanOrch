import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StrewApplication } from "./application.ts";
import { startRuntimeServer } from "./server.ts";

const dataDirectory = resolve(process.env.KANORCH_DATA_DIR ?? process.env.STREW_DATA_DIR ?? ".strew");
const databasePath = resolve(dataDirectory, "strew.db");
const port = Number.parseInt(process.env.KANORCH_PORT ?? process.env.STREW_PORT ?? "4174", 10);
const staticRoot = resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const application = new StrewApplication(databasePath);
const runtime = await startRuntimeServer(application, { port, staticRoot });

process.stdout.write(`KanOrch runtime listening on http://${runtime.host}:${runtime.port}\n`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await runtime.close();
  application.close();
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
