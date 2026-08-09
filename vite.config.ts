import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";

/** [배포 반영 2026-08-09, 사용자] 사람들이 Ctrl+F5를 안 해서 옛 클라로 계속 플레이하는 문제.
 *  빌드마다 고유 ID를 ①번들에 심고(__BUILD_ID__) ②dist/public/build-id.txt에 남긴다.
 *  서버는 ②를 읽어 소켓 접속 시 알려주고, 클라는 ①과 달라지면 '새 버전' 배너를 띄운다.
 *  dev(vite 미들웨어)에는 build-id.txt가 없어 서버가 null을 보내므로 배너가 뜨지 않는다. */
const BUILD_ID = process.env.BUILD_ID || Date.now().toString(36);

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [
    react(),
    {
      name: "emit-build-id",
      apply: "build",
      closeBundle() {
        const out = path.resolve(import.meta.dirname, "dist/public/build-id.txt");
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, BUILD_ID, "utf8");
      },
    },
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
