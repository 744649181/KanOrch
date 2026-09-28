import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function TerminalPane({ projectId, runId }: { projectId: string; runId: string }): React.ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState("正在连接终端…");
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    const terminal = new Terminal({ cursorBlink: true, fontSize: 12, scrollback: 5000 });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
    fit.fit();
    let socket: WebSocket | null = null;
    let retry: number | null = null;
    let closed = false;
    let running = true;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/api/projects/${encodeURIComponent(projectId)}/terminals/${encodeURIComponent(runId)}/stream`;
    const sendSize = () => {
      fit.fit();
      if (socket?.readyState === WebSocket.OPEN && running) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };
    const observer = new ResizeObserver(sendSize);
    observer.observe(container.current);
    const input = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN && running) socket.send(JSON.stringify({ type: "input", data }));
    });
    const connect = () => {
      socket = new WebSocket(url);
      socketRef.current = socket;
      socket.addEventListener("open", () => setStatus("已连接"));
      socket.addEventListener("message", (event) => {
        const body = JSON.parse(String(event.data)) as {
          type: string; data?: string; status?: string; truncated?: boolean; exitCode?: number;
        };
        if (body.type === "snapshot") {
          terminal.reset();
          terminal.write(body.data ?? "");
          running = body.status === "running";
          setRunning(running);
          setStatus(body.truncated ? "已连接 · 历史输出已截断" : running ? "已连接" : "会话已结束");
          sendSize();
        } else if (body.type === "data") {
          terminal.write(body.data ?? "");
        } else if (body.type === "exit") {
          running = false;
          setRunning(false);
          setStatus(`会话已结束（退出码 ${body.exitCode ?? "?"}）`);
        }
      });
      socket.addEventListener("close", (event) => {
        setRunning(false);
        setStatus(event.code === 1008 ? "会话不可用，请查看运行日志" : "终端连接已断开");
        if (!closed && running && event.code !== 1008) retry = window.setTimeout(connect, 1000);
      });
    };
    connect();
    return () => {
      closed = true;
      if (retry !== null) window.clearTimeout(retry);
      observer.disconnect();
      input.dispose();
      socket?.close();
      socketRef.current = null;
      terminal.dispose();
    };
  }, [projectId, runId]);

  return <div className="terminal-pane"><div className="terminal-toolbar"><span>{status}</span><button type="button" disabled={!running} onClick={() => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
  }}>停止</button></div><div className="terminal-surface" ref={container} /></div>;
}
