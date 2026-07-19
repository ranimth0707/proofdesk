/**
 * Dashboard: zero-dependency HTTP server.
 *   GET /            → single-page UI
 *   GET /api/state   → full engine state snapshot (JSON)
 *   GET /events      → SSE push of every engine event (the desk speaks the
 *                      same protocol it consumes — SSE in, SSE out)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Engine } from "../engine.js";
import type { EngineEvent } from "../types.js";
import { makeLog } from "../log.js";

const log = makeLog("dashboard");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startDashboard(engine: Engine, port: number): http.Server {
  const clients = new Set<http.ServerResponse>();

  engine.bus.on("event", (ev: EngineEvent) => {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients) res.write(line);
  });

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "/index.html") {
      const html = fs.readFileSync(path.join(__dirname, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(engine.stateSnapshot()));
      return;
    }
    if (url === "/api/history") {
      // Chart backfill: every persisted quote, oldest first.
      const quotes = engine.ledger.recentQuotes(5000).reverse();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(quotes));
      return;
    }
    if (url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  server.listen(port, () => log.info(`dashboard on http://localhost:${port}`));
  return server;
}
