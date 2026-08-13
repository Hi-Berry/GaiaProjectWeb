/**
 * pm2 환경변수 설정 템플릿 (자체 호스팅용 — Render의 Environment 탭을 대신한다).
 *
 * 이 프로젝트는 dotenv를 쓰지 않는다. `.env` 파일을 만들어도 읽지 않으니
 * 반드시 진짜 프로세스 환경변수로 넣어야 한다 → pm2 ecosystem 파일이 그 자리다.
 *
 * 사용:
 *   cp ecosystem.config.example.cjs ecosystem.config.cjs
 *   vi ecosystem.config.cjs                 # 실제 값 채우기 (이 파일은 .gitignore 대상)
 *   pm2 delete gaia 2>/dev/null
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * 값을 바꾼 뒤에는 반드시 --update-env 를 줘야 반영된다:
 *   pm2 restart gaia --update-env
 *
 * 확장자가 .cjs인 이유: package.json이 "type": "module" 이라 .js로 두면 pm2가 require에 실패한다.
 */
module.exports = {
  apps: [
    {
      name: 'gaia',
      script: 'npm',
      args: 'start',                 // = cross-env NODE_ENV=production node dist/index.cjs
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',             // 게임 상태가 프로세스 메모리에 있으므로 cluster 금지(좌석이 갈린다)
      autorestart: true,
      max_restarts: 10,
      // 메모리 상한 — Render 512MB에서 OOM 났던 이력이 있다. 장비 RAM에 맞춰 조정.
      max_memory_restart: '1G',
      env: {
        // ── 필수 ──────────────────────────────────────────────
        NODE_ENV: 'production',
        PORT: '5000',
        // HOST: '0.0.0.0',          // 미지정이면 전 인터페이스에서 수신. 특정 IP에만 열려면 지정.

        // ── 저장소 ────────────────────────────────────────────
        // 미설정이면 인메모리로 폴백한다(재시작 시 진행 중 게임 소실).
        // DATABASE_URL: 'postgres://user:pass@host:5432/dbname',

        // ── 사람 게임 기록 업로드 (Supabase) ──────────────────
        // SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 둘 다 있으면 자동으로 Supabase 업로드가 켜진다
        // (HUMAN_LOG_STORAGE를 'local'로 명시하면 강제로 로컬 저장).
        // SUPABASE_URL: 'https://xxxx.supabase.co',
        // SUPABASE_SERVICE_ROLE_KEY: '...',        // ★ 서비스 롤 키 — 절대 커밋 금지
        // HUMAN_LOG_SUPABASE_TABLE: '...',         // 기본값 human_game_sessions
        // HUMAN_LOG_STORAGE: 'local',              // 자격증명이 있어도 로컬에만 남기고 싶을 때

        // ── 기록 사이트 연동 ──────────────────────────────────
        // 둘 다 있어야 동작한다(하나만 있으면 조용히 스킵).
        // SCORE_SITE_URL: '...',
        // SCORE_SITE_TOKEN: '...',

        // ── 운영 토큰 ─────────────────────────────────────────
        // 상태 페이지의 '여기서 플레이하세요' 지정용. 미설정 시 기본값 '0011'이 쓰이므로
        // 외부에 열려 있는 서버라면 반드시 바꿀 것.
        // STATUS_ADMIN_TOKEN: '...',
        // AI_TUNING_TOKEN: '...',

        // ── 봇/기능 토글 ──────────────────────────────────────
        // 미설정이면 봇 허용(true). '0'/'false'/'off'/'no' 중 하나면 비활성.
        // AI_ENABLED / AI_AVAILABLE / AI_BOTS_ENABLED 아무거나 쓰면 된다.
        // 비활성 서버는 상태 페이지에서 '사람 전용'으로 분류돼 추천 대상이 된다.
        // AI_BOTS_ENABLED: '0',
        // BOT_DELAY_MS: '800',        // 봇 착수 간 지연

        // ── 계측(평상시 끔) ───────────────────────────────────
        // EMIT_BYTES: '1',            // 소켓 emit 바이트/델타 측정
        // LOG_MEMORY: '1',
      },
    },
  ],
};
