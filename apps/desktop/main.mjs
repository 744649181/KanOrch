import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog } from "electron";

const root = fileURLToPath(new URL("../../", import.meta.url));
let server = null;
let window = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    quitting = true;
    server?.kill();
  });
  app.whenReady().then(async () => {
    try {
      const url = await startServer();
      window = new BrowserWindow({
        title: "KanOrch",
        width: 1500,
        height: 950,
        minWidth: 900,
        minHeight: 650,
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, destination) => {
        if (new URL(destination).origin !== new URL(url).origin) event.preventDefault();
      });
      window.once("ready-to-show", () => window?.show());
      await window.loadURL(url);
      if (process.env.KANORCH_DESKTOP_SMOKE === "1") {
        const rendered = await window.webContents.executeJavaScript("Boolean(document.querySelector('#root')?.textContent?.trim())");
        if (!rendered) throw new Error("The desktop window loaded without rendering KanOrch.");
        process.stdout.write(`KanOrch desktop ready at ${url}\n`);
        app.quit();
      }
    } catch (error) {
      process.exitCode = 1;
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      if (process.env.KANORCH_DESKTOP_SMOKE !== "1") {
        dialog.showErrorBox("KanOrch could not start", error instanceof Error ? error.message : String(error));
      }
      app.quit();
    }
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const dataDirectory = process.env.KANORCH_DATA_DIR ?? join(app.getPath("userData"), "data");
    const runtime = join(root, "apps", "runtime", "src", "main.ts");
    const child = spawn(process.env.KANORCH_NODE ?? "node", [runtime], {
      cwd: root,
      env: { ...process.env, KANORCH_DATA_DIR: dataDirectory, KANORCH_PORT: process.env.KANORCH_PORT ?? "0" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server = child;
    let ready = false;
    let output = "";
    let errors = "";
    const timer = setTimeout(() => {
      if (ready) return;
      child.kill();
      reject(new Error("The local server did not become ready within 30 seconds."));
    }, 30_000);
    child.stderr.on("data", (chunk) => { errors = `${errors}${chunk.toString()}`.slice(-4_000); });
    child.stdout.on("data", (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-4_000);
      const match = output.match(/KanOrch runtime listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (!match || ready) return;
      ready = true;
      clearTimeout(timer);
      resolve(match[1]);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!ready) reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!ready) reject(new Error(`The local server exited (${code ?? "unknown"}). ${errors}`));
      else if (!quitting) app.quit();
    });
  });
}
