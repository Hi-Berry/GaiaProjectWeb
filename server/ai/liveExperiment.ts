/**
 * 실게임(사람 + 봇 혼합) 좌석 A/B — head2head가 못 재는 축을 실전에서 재는 장치.
 *
 * 배경(DECISIONS 2026-09-18): 자가대국은 리치 기근·경합 부재라 "사람 상대에서만 성립하는" 전략
 * (연방 예비토큰 완화·번 조달·1O1Q 타일·4P 액션 타일 등)을 전부 중립/음수로 판정했고, 실게임 판정은
 * "배포 후 관찰"에 의존해 왔다. 이 모듈은 사람 게임에 봇이 추가될 때 **같은 게임 안의 봇 좌석을 ON/OFF로
 * 번갈아 배정**해(1번째 봇 ON, 2번째 OFF, … 게임별 시작 패리티는 gameId 해시) 같은 맵·같은 사람 상대라는
 * 조건을 통제한 쌍비교 데이터를 쌓는다. 결과는 humanGameLogger가 players[pid].liveVariant로 저장하고
 * `.claude/skills/gaia-ai-lab/scripts/liveAbReport.mjs`가 게임 내 ON−OFF 차이를 집계한다.
 *
 * 설정: server/ai/liveExperiment.json  { "name": "fedReserveRelaxR34", "flags": { "fedReserveRelaxR34": true } }
 *       name이 없거나 flags가 비면 비활성(기본). 파일은 봇 추가 시마다 다시 읽으므로 서버 재시작 없이 교체 가능.
 *       환경변수 LIVE_BOT_FLAGS='{"name":"x","flags":{...}}' 가 있으면 파일보다 우선.
 * 범위: 사람 방장이 봇을 추가하는 경로(host_add_bot)만. head2head/자가대국(auto setup)은 자기 variant를 쓴다.
 */
import * as fs from 'fs';
import * as path from 'path';
import { setPlayerVariant } from './variant';

export type LiveExperiment = { name: string; flags: Record<string, number | boolean> };

const CONFIG_PATH = path.resolve(process.cwd(), 'server/ai/liveExperiment.json');

function parseExperiment(raw: unknown): LiveExperiment | null {
    if (!raw || typeof raw !== 'object') return null;
    const { name, flags } = raw as { name?: unknown; flags?: unknown };
    if (typeof name !== 'string' || !name.trim()) return null;
    if (!flags || typeof flags !== 'object' || Object.keys(flags as object).length === 0) return null;
    return { name: name.trim(), flags: flags as Record<string, number | boolean> };
}

/** 현재 활성 실험(없으면 null). 매 호출 시 파일을 다시 읽는다(작은 JSON, 봇 추가 시에만 호출). */
export function loadLiveExperiment(): LiveExperiment | null {
    const env = process.env.LIVE_BOT_FLAGS;
    if (env) {
        try { return parseExperiment(JSON.parse(env)); } catch { return null; }
    }
    try {
        if (!fs.existsSync(CONFIG_PATH)) return null;
        return parseExperiment(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    } catch {
        return null;
    }
}

function gameParity(gameId: string): number {
    let h = 0;
    for (let i = 0; i < gameId.length; i++) h = (h * 31 + gameId.charCodeAt(i)) >>> 0;
    return h & 1;
}

/**
 * 사람 게임에 봇이 추가될 때 호출. 실험이 활성이면 이 봇 좌석을 ON/OFF 그룹에 배정하고
 * variant 레지스트리(getPlayerFlag가 읽음)와 플레이어 상태(로그 저장용)에 기록한다.
 * 반환: 배정 라벨('on'|'off') 또는 null(비활성).
 */
export function assignLiveBotVariant(
    game: { id: string; botPlayerIds?: string[]; players: Record<string, unknown> },
    botId: string,
): 'on' | 'off' | null {
    const exp = loadLiveExperiment();
    if (!exp) return null;
    const idx = Math.max(0, (game.botPlayerIds ?? []).indexOf(botId));
    const group: 'on' | 'off' = ((idx + gameParity(game.id)) % 2 === 0) ? 'on' : 'off';
    // OFF 좌석도 라벨만 가진 variant를 등록해 두면(flags 없음 → 전부 기본값) 집계 시 그룹을 구분할 수 있다.
    setPlayerVariant(botId, { label: `live:${exp.name}:${group}`, flags: group === 'on' ? { ...exp.flags } : {} });
    const p = game.players[botId] as Record<string, unknown> | undefined;
    if (p) p.liveVariant = { name: exp.name, group, flags: group === 'on' ? { ...exp.flags } : {} };
    return group;
}
