/**
 * 방 한정 좌석 비밀번호 (2026-07-16 사용자 설계: "ID/비번은 그 방 한정 — 다른 방에선 같은 ID여도 다른 일회용 비번")
 * - 전역 계정 없음. 방에 참가할 때 비번을 걸면(선택) 그 방의 그 좌석에만 묶인다.
 * - 다른 기기에서 같은 방 URL + 같은 이름/비번 → 그 좌석 playerId를 돌려받아 이어하기.
 * - 저장: 서버 메모리(게임과 수명 동일). 게임 객체 밖에 둬서 game_updated 브로드캐스트에 해시가 안 실린다.
 * - 비번 없이 참가하면 기존 익명 방식 그대로.
 */
import * as crypto from 'crypto';

interface SeatAuth { salt: string; hash: string; name: string }

/** gameId → (playerId → SeatAuth) */
const seatAuthByGame = new Map<string, Map<string, SeatAuth>>();

function hashPw(password: string, salt: string): string {
    return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

const normName = (n: string) => String(n ?? '').trim().toLowerCase();

/** 참가 시 좌석에 비번 걸기 (덮어쓰기 허용 — 같은 좌석 재설정은 본인 소켓만 가능하게 호출부에서 보장) */
export function setSeatPassword(gameId: string, playerId: string, playerName: string, password: string) {
    if (!password) return;
    const salt = crypto.randomBytes(12).toString('hex');
    if (!seatAuthByGame.has(gameId)) seatAuthByGame.set(gameId, new Map());
    seatAuthByGame.get(gameId)!.set(playerId, { salt, hash: hashPw(password, salt), name: normName(playerName) });
}

/** 이름+비번으로 좌석 찾기 — 같은 이름 좌석이 여럿이면 비번이 맞는 첫 좌석 반환 */
export function findSeatByPassword(gameId: string, playerName: string, password: string): string | null {
    const seats = seatAuthByGame.get(gameId);
    if (!seats) return null;
    const name = normName(playerName);
    for (const [playerId, auth] of Array.from(seats.entries())) {
        if (auth.name !== name) continue;
        const candidate = Buffer.from(hashPw(password, auth.salt), 'hex');
        const stored = Buffer.from(auth.hash, 'hex');
        if (candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored)) return playerId;
    }
    return null;
}

/** 게임 정리 시 함께 삭제(메모리 누수 방지) */
export function clearSeatAuth(gameId: string) {
    seatAuthByGame.delete(gameId);
}

/** [사용자 2026-11-28 진행 중 게임 저장·복원] 좌석 비밀번호(솔트+해시)를 스냅샷에 실어 서버 재시작 뒤에도 '이어하기'가 되게 한다. 원문 비번은 없다. */
export function exportSeatAuth(gameId: string): Array<[string, SeatAuth]> {
    return Array.from(seatAuthByGame.get(gameId)?.entries() ?? []);
}
export function importSeatAuth(gameId: string, entries: Array<[string, SeatAuth]> | undefined) {
    if (!entries?.length) return;
    seatAuthByGame.set(gameId, new Map(entries));
}
