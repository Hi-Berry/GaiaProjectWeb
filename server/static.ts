import express, { type Express } from "express";
import fs from "fs";
import path from "path";

/** [배포 반영 2026-08-09, 사용자] 빌드 시 vite가 dist/public/build-id.txt에 남긴 ID.
 *  프로세스 시작 시 1회만 읽는다(배포 = 새 컨테이너 = 새 값). dev에는 파일이 없어 null. */
let cachedBuildId: string | null | undefined;
export function getClientBuildId(): string | null {
	if (cachedBuildId !== undefined) return cachedBuildId;
	try {
		const p = path.resolve(__dirname, "public", "build-id.txt");
		cachedBuildId = fs.readFileSync(p, "utf8").trim() || null;
	} catch {
		cachedBuildId = null;
	}
	return cachedBuildId;
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // [배포 반영 2026-07-27, 사용자] index.html이 캐시되면 옛 번들을 계속 가리켜 강력 새로고침이 필요했음.
  // 해시 번들(assets)은 영구 캐시, html은 매번 재검증 → 일반 새로고침(또는 재접속)만으로 새 버전 반영.
  app.use(express.static(distPath, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache");
      } else if (/[.-][0-9a-zA-Z_]{8,}\.(js|css)$/.test(filePath) || filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }));

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
