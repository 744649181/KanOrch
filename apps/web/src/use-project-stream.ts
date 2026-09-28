import { useEffect, useRef, useState } from "react";

interface StreamState {
  connected: boolean;
  cursor: number;
}

export function useProjectStream(projectId: string | null, onEvent: () => void): StreamState {
  const [state, setState] = useState<StreamState>({ connected: false, cursor: 0 });
  const callback = useRef(onEvent);
  const projectCursors = useRef<Record<string, number>>({});
  callback.current = onEvent;

  useEffect(() => {
    if (!projectId) return;
    let closed = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;
    let cursor = projectCursors.current[projectId] ?? 0;
    setState({ connected: false, cursor });

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/api/events?projectId=${encodeURIComponent(projectId)}&after=${cursor}`;
      socket = new WebSocket(url);
      socket.addEventListener("open", () => setState((current) => ({ ...current, connected: true })));
      socket.addEventListener("message", (message) => {
        const body = JSON.parse(String(message.data)) as {
          type?: string;
          cursor?: number;
          event?: { sequence?: number };
        };
        if (body.type === "event" && typeof body.event?.sequence === "number") {
          cursor = Math.max(cursor, body.event.sequence);
          projectCursors.current[projectId] = cursor;
          setState({ connected: true, cursor });
          callback.current();
        } else if (body.type === "ready" && typeof body.cursor === "number") {
          cursor = Math.max(cursor, body.cursor);
          projectCursors.current[projectId] = cursor;
          setState({ connected: true, cursor });
        }
      });
      socket.addEventListener("close", () => {
        setState((current) => ({ ...current, connected: false }));
        if (!closed) retryTimer = window.setTimeout(connect, 1_000);
      });
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [projectId]);

  return state;
}
