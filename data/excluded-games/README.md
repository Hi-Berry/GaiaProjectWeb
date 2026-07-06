# 제외된(버그 오염) 게임 — 연구·학습에 쓰지 말 것

이 폴더의 게임은 **버그로 오염되어 정상 플레이가 아니므로**, 봇 분석/학습(bad-patterns·faction-scores·econTrajectory·candidateProbe·valueProbe·path2 재학습 등) 데이터에서 **영구 제외**한다. 연구 스크립트는 `data/human-games/*.json`만 글롭하므로 여기 두면 자동 제외되고, `scripts/fetchSupabaseGames.mjs`의 `EXCLUDED_GAME_IDS`에도 등록해 재다운로드를 막았다.

| 게임 | 날짜 | 제외 사유 |
|---|---|---|
| `2026-07-06_na0vujw3.json` | 2026-07-06 | 월클록 워치독이 **사람 income 대기(느린 선택+접속끊김+undo)** 를 봇 hang으로 오판 → 봇 2명 강제스킵. HH는 R3 시작(06:06:47), bescods는 R4 시작(06:22:35)에 강제스킵되고 turnOrder에서 소멸 → **R4~6은 사람 2명만 플레이**, 봇 15/23점으로 조기종료. 봇의 "R3+ 무행동 패스"는 봇 결정이 아니라 버그(강제스킵). 정상 플레이 아님. (수정 커밋: 7444248 워치독 income-가드 + 34163a2 turnOrder 보존.) |

## Supabase 주의
이 게임은 서버가 완주 시 Supabase(`human_game_sessions`)에도 업로드했다("uploaded to Supabase: na0vujw3"). `fetchSupabaseGames.mjs`의 `EXCLUDED_GAME_IDS`가 재다운로드를 막지만, **Supabase 원본 행 자체를 지우려면 별도로 DB에서 삭제**해야 한다(여기선 미수행).
