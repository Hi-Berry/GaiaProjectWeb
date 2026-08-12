import express, { type Request, Response, NextFunction } from "express";
import compression from "compression";
import { createServer } from "http";
import os from "os";
import { registerRoutes } from "./routes";
import { serveStatic, getClientBuildId } from "./static";
import { setupGameServer, setHumanCandidateHook, getRoomStats } from "./gameState";
import { attachNetStats, getNetStats, mb } from "./netStats";
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

// [대역폭 2026-08-12, 사용자] 정적 파일이 무압축으로 나가고 있었다 — 클라 번들 998KB + CSS가 그대로 전송.
//   실측: 압축 대상 1.09MB → gzip 0.31MB (72% 절감). 배포로 파일명이 바뀔 때마다 전원이 다시 받으므로
//   배포가 잦을수록 누적이 크다(캐시는 immutable로 이미 걸려 있어 재방문은 0바이트).
//   ※ socket.io는 httpServer에 직접 붙어 Express 미들웨어를 안 타므로 여기 영향 없음
//     (게임 트래픽은 자체 perMessageDeflate로 이미 압축 중 — gameState.ts:3057).
//   ※ 이미지/폰트처럼 이미 압축된 형식은 compression이 기본 필터로 건너뛴다.
app.use(compression());

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
    // /api/status는 상태페이지(탭당 30초×3서버)+keep-alive 핑이 계속 때려 로그 도배 → 로깅 제외(사용자)
    if (path.startsWith("/api") && path !== "/api/status") {
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
  // [상태 대시보드] Netlify status 페이지용 — CORS 전체 허용(공개 카운트만 반환, 개인정보/게임내용 없음)
  const { getPublicStatus, getStatusNotice, setStatusNotice } = await import("./gameState");
  app.get("/api/status", (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.json(getPublicStatus());
  });

  // [배포 반영 2026-08-09, 사용자] 현재 서버가 서빙 중인 클라 빌드 ID. 소켓이 끊긴 상태에서도
  //   폴링으로 확인할 수 있게 HTTP로도 노출. dev면 null(=배너 비활성).
  app.get("/api/version", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ buildId: getClientBuildId() });
  });

  // [상태 페이지 실시간 안내 2026-08-04, 사용자] '여기서 플레이하세요'를 재배포·재시작 없이 즉시 지정/해제.
  //   예) /api/status/notice?token=0011&recommend=1&text=여기서%20플레이하세요
  //       /api/status/notice?token=0011&clear=1
  //   GET도 허용 — 폰 브라우저에 URL만 붙여넣어 바꿀 수 있어야 한다는 게 이 기능의 목적.
  //   CORS 헤더는 일부러 안 붙임(다른 사이트가 브라우저를 통해 건드리지 못하게). 토큰은 STATUS_ADMIN_TOKEN으로
  //   덮어쓸 수 있고, 미설정 시 기존 어드민 코드('0011')를 쓴다 — 4자리는 약하므로 공개 운영 시 env 설정 권장.
  const statusNoticeHandler = (req: Request, res: Response) => {
    const expected = process.env.STATUS_ADMIN_TOKEN?.trim() || '0011';
    const q = { ...(req.query as Record<string, unknown>), ...((req.body ?? {}) as Record<string, unknown>) };
    const token = typeof q.token === 'string' ? q.token : '';
    if (token !== expected) { res.status(403).json({ ok: false, error: 'invalid token' }); return; }

    const truthy = (v: unknown) => v === true || v === '1' || v === 'true' || v === 'on' || v === 'yes';
    if (truthy(q.clear)) {
      const n = setStatusNotice({ text: '', recommend: false });
      res.json({ ok: true, cleared: true, notice: n });
      return;
    }
    const next: { text?: string; recommend?: boolean } = {};
    if (typeof q.text === 'string') next.text = q.text;
    if (q.recommend !== undefined) next.recommend = truthy(q.recommend);
    if (next.text === undefined && next.recommend === undefined) {
      res.json({ ok: true, unchanged: true, notice: getStatusNotice() }); // 조회용
      return;
    }
    const n = setStatusNotice(next);
    log(`[STATUS-NOTICE] recommend=${n.recommend} text="${n.text}"`, 'express');
    res.json({ ok: true, notice: n });
  };
  app.get("/api/status/notice", statusNoticeHandler);
  app.post("/api/status/notice", statusNoticeHandler);

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

  // [사용자 2026-08-11] 실제 회선 송수신량 계측 — socket.io 업그레이드 전 TCP 단계부터 잡아야 하므로
  //   setupGameServer보다 먼저 연결 훅을 건다.
  attachNetStats(httpServer);

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

// 메모리 사용량 로그 — 기존엔 10초마다 '무조건' 찍어 로그를 도배했다(사용자: "메모리 로그 너무 많아 보기 힘듦").
// 고친 핵심은 폴링 속도가 아니라 '출력 게이팅'이다. 폴링은 원래대로 10초 유지(더 자주 만들 이유 없음).
//  10초마다 체크해서 ①RSS가 직전 출력 대비 ±20MB 이동(누수/급증 신호) ②5분 하트비트 중 하나면 출력.
//  5MB/초 누수: 10초에 +50MB → 임계(20MB) 넘어 매 폴링(10초)마다 출력 → 터지기 전 궤적이 남는다. 정상: 하트비트만.
// 환경변수: LOG_MEMORY=off(끄기) · LOG_MEMORY=all(10초마다 매번) · 미설정=스마트.
{
  const mode = (process.env.LOG_MEMORY || 'smart').toLowerCase();
  if (mode !== 'off') {
    let lastRssMb = 0;
    let lastEmit = 0;
    let lastOut = 0;
    let lastNetAt = Date.now();
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
      // [사용자 2026-08-11] 같은 주기로 실제 송수신량도 남긴다 — 누적 + 직전 로그 이후 증가분 + 시간당 환산.
      //   하루 몇 GB인지 바로 읽히게 하는 게 목적이라 rate(MB/h)를 같이 찍는다.
      const net = getNetStats();
      const dOut = net.outBytes - lastOut;
      const hours = Math.max(1e-6, (now - lastNetAt) / 3600000);
      lastOut = net.outBytes;
      lastNetAt = now;
      // 관전자도 game_updated를 그대로 받으므로 송신량은 '방 인원 수'에 비례한다 → 같이 찍어야 숫자가 해석된다.
      const room = getRoomStats();
      log(
        `Network: out=${mb(net.outBytes)}MB in=${mb(net.inBytes)}MB (+${mb(dOut)}MB, ${mb(dOut / hours)}MB/h) conns=${net.liveConns}/${net.totalConns} games=${room.games} seats=${room.players} spectators=${room.spectators} receivers=${room.receivers}`,
        "system",
      );
    }, 10000);
  }
}

