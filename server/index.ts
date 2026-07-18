import express, { type Request, Response, NextFunction } from "express";
import { createServer } from "http";
import os from "os";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { setupGameServer, setHumanCandidateHook } from "./gameState";
import { BotLogic } from "./ai/bot";
import { StateCloner } from "./ai/stateCloner";

// [per-candidate 학습] 사람 결정시점의 가능 후보를 turnStartState에 캡처하도록 BotLogic 주입(DI, 순환참조 회피).
// ★ 반드시 클론에 호출 — getCandidateMoves가 후보생성 중 game을 임시변경(pendingSteps 등)하므로
//   라이브 게임 손상 방지 위해 복제본에서만 실행(복원 실패해도 네 실제 게임엔 무영향).
setHumanCandidateHook((g, pid) => {
  const clone = StateCloner.cloneGameStateForSimulation(g as any);
  (clone as any).simulation = true;
  return BotLogic.getCandidateMoves(clone, pid);
});

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

import fs from "fs";
import path from "path";

export function log(message: string, source = "express", gameId?: string, options?: { simulation?: boolean }) {
  if (options?.simulation) return;
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  const logLine = `${formattedTime} [${source}] ${message}`;
  console.log(logLine);

  if (gameId) {
    const logDir = path.join(process.cwd(), "logs");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, `game_${gameId}.log`);
    fs.appendFileSync(logFile, logLine + "\n");
  }
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
    log(`Global error handler caught: ${message}`, 'error');
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
  const host = process.env.HOST?.trim();
  const onListening = () => {
    const { local, lan } = getConnectionUrls(port);
    log("--- 접속 주소 (다른 사람이 접속할 URL) ---", "express");
    log(`  로컬: ${local}`, "express");
    if (lan.length > 0) {
      log(`  같은 네트워크: ${lan.join(", ")}`, "express");
    } else {
      log("  같은 네트워크: (감지된 LAN IP 없음)", "express");
    }
    log("----------------------------------------", "express");
    log(`serving on ${host || 'all interfaces'}:${port}`);
  };
  if (host) {
    httpServer.listen(port, host, onListening);
  } else {
    httpServer.listen(port, onListening);
  }

  // Setup Socket.IO game server
  setupGameServer(httpServer);
  log('Game server initialized on same port', 'socket.io');
})();

// Prevent server from crashing on unhandled errors
process.on('unhandledRejection', (reason, promise) => {
  log(`Unhandled Rejection at: ${promise}, reason: ${reason}`, 'error');
});

process.on('uncaughtException', (err) => {
  log(`Uncaught Exception thrown: ${err.message}\n${err.stack}`, 'error');
});

// 메모리 사용량 로그 — 기존엔 10초마다 무조건 찍어 로그를 도배했다(사용자: "메모리 로그 너무 많아 보기 힘듦").
// 핵심: 확인은 '자주'(3초), 출력만 '선별적'. 폴링을 느리게 하면 빠른 누수(예: 5MB/초)가 폴링 전에 터져 로그가 한 줄도 안 남는다(사용자 지적).
//  → 3초마다 체크해서 ①RSS가 직전 출력 대비 ±20MB 이동(누수/급증 신호) ②직전 출력 대비 절대치 급변 ③5분 하트비트 중 하나면 출력.
//  빠른 누수: 3초마다 +15MB씩 쌓이다 20MB 넘는 순간부터 매 폴링 출력 → 터지기 전 궤적이 남는다. 정상: 하트비트만.
// 환경변수: LOG_MEMORY=off(끄기) · LOG_MEMORY=all(3초마다 매번) · 미설정=스마트.
{
  const mode = (process.env.LOG_MEMORY || 'smart').toLowerCase();
  if (mode !== 'off') {
    let lastRssMb = 0;
    let lastEmit = 0;
    const HEARTBEAT_MS = 5 * 60 * 1000;
    const DELTA_MB = 20;
    setInterval(() => {
      const m = process.memoryUsage();
      const rssMb = m.rss / 1024 / 1024;
      const now = Date.now();
      const moved = Math.abs(rssMb - lastRssMb) >= DELTA_MB;
      const heartbeat = now - lastEmit >= HEARTBEAT_MS;
      if (mode !== 'all' && !moved && !heartbeat) return;
      lastRssMb = rssMb;
      lastEmit = now;
      log(
        `Memory usage: RSS=${rssMb.toFixed(2)}MB, HeapTotal=${(m.heapTotal / 1024 / 1024).toFixed(2)}MB, HeapUsed=${(m.heapUsed / 1024 / 1024).toFixed(2)}MB, External=${(m.external / 1024 / 1024).toFixed(2)}MB`,
        "system",
      );
    }, 3000);
  }
}

