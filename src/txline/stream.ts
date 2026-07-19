/**
 * SSE stream consumer for TxLINE odds and scores feeds.
 *
 * Uses the `eventsource` package (WHATWG EventSource for Node) with a custom
 * fetch that injects both auth headers and renews the guest JWT when the
 * server rejects a connection — the same pattern as TxODDS' own devnet
 * examples. EventSource handles reconnection with backoff natively; we add
 * a watchdog that force-reconnects if no message or heartbeat arrives within
 * `idleReconnectMs` (dead-connection defence for long tournaments).
 */

import { EventSource } from "eventsource";
import { activeNetwork } from "../config.js";
import { makeLog } from "../log.js";
import type { AuthManager } from "./auth.js";

export type StreamName = "odds" | "scores";

export interface StreamHandle {
  close(): void;
}

export function openStream(
  auth: AuthManager,
  stream: StreamName,
  onFrame: (recvTs: number, raw: string) => void,
  opts: { idleReconnectMs?: number } = {}
): StreamHandle {
  const log = makeLog(`sse:${stream}`);
  const url = `${activeNetwork().apiBaseUrl}/${stream}/stream`;
  const idleReconnectMs = opts.idleReconnectMs ?? 5 * 60 * 1000;

  let es: EventSource | null = null;
  let lastActivity = Date.now();
  let closed = false;

  const connect = () => {
    if (closed) return;
    es = new EventSource(url, {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const attempt = (jwt: string) =>
          fetch(input, {
            ...init,
            headers: {
              ...(init?.headers as Record<string, string>),
              Authorization: `Bearer ${jwt}`,
              "X-Api-Token": auth.apiToken,
              Accept: "text/event-stream",
              "Cache-Control": "no-cache",
            },
          });
        let res = await attempt(auth.jwt);
        if (res.status === 401 || res.status === 403) {
          log.info(`connection rejected (${res.status}); renewing JWT`);
          const jwt = await auth.renewJwt();
          res = await attempt(jwt);
        }
        return res;
      },
    });

    es.onopen = () => {
      lastActivity = Date.now();
      log.info("stream open", url);
    };
    es.onmessage = (event: MessageEvent) => {
      lastActivity = Date.now();
      if (typeof event.data === "string" && event.data.length > 0) {
        onFrame(Date.now(), event.data);
      }
    };
    es.onerror = (err: unknown) => {
      lastActivity = Date.now(); // errors trigger ES-internal reconnects; don't double-fire watchdog
      log.warn("stream error (EventSource will reconnect):", summarize(err));
    };
  };

  connect();

  const watchdog = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastActivity > idleReconnectMs) {
      log.warn(`no activity for ${idleReconnectMs / 1000}s — forcing reconnect`);
      es?.close();
      connect();
      lastActivity = Date.now();
    }
  }, 30_000);

  return {
    close() {
      closed = true;
      clearInterval(watchdog);
      es?.close();
    },
  };
}

function summarize(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: string; code?: number; status?: number };
    return `${e.code ?? e.status ?? ""} ${e.message ?? ""}`.trim() || "connection error";
  }
  return String(err);
}
