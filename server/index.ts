import express, { type Request, Response, NextFunction } from "express";
import { createServer } from "http";
import os from "os";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { setupGameServer } from "./gameState";

function getConnectionUrls(port: number): { local: string; lan: string[] } {
  const local = `http://localhost:${port}`;
  const lan: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const dev of Object.values(ifaces)) {
    if (!dev) continue;
    for (const iface of dev) {
      if ((iface.family === "IPv4" || (iface as any).family === 4) && !iface.internal) lan.push(`http://${iface.address}:${port}`);
    }
  }
  return { local, lan };
}

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

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
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
  httpServer.listen(port, () => {
    const { local, lan } = getConnectionUrls(port);
    log("--- 접속 주소 (다른 사람이 접속할 URL) ---", "express");
    log(`  로컬: ${local}`, "express");
    if (lan.length > 0) {
      log(`  같은 네트워크: ${lan.join(", ")}`, "express");
    } else {
      log("  같은 네트워크: (감지된 LAN IP 없음)", "express");
    }
    log("----------------------------------------", "express");
    log(`serving on port ${port}`);
  });

  // Setup Socket.IO game server
  setupGameServer(httpServer);
  log('Game server initialized on same port', 'socket.io');
})();
