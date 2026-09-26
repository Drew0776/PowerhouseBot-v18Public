import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { setupAuth } from "./auth";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));
setupAuth(app);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

// Request log: method, path, status and timing only. Response bodies are not
// logged — the dashboard polls large payloads (signals, equity curve, account
// data) every few seconds, which flooded the logs on a 24/7 server.
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    if (path.startsWith("/api")) {
      log(`${req.method} ${path} ${res.statusCode} in ${Date.now() - start}ms`);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  // V19: Auto-resume — if the engine was running before the last server restart, pick back up
  try {
    const { getEngineStateJson } = await import("./storage");
    const json = getEngineStateJson();
    if (json) {
      const s = JSON.parse(json);
      if (s.isRunning === true) {
        const { startAutoTrader } = await import("./auto-trader");
        startAutoTrader();
        log("🔄 Auto-resumed: engine was running at last shutdown — restarting background tick loop");
      }
    }
  } catch (_e) { /* non-fatal — fresh start if engine_state missing or corrupt */ }

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    // Client errors (e.g. malformed JSON) keep their message; server errors
    // stay generic so internals don't leak to callers. Full error is logged.
    const message = status < 500 ? (err.message || "Bad Request") : "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
