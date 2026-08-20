/**
 * Utility for playing notification sounds using the Web Audio API.
 * This avoids the need for external audio assets.
 */

let audioCtx: AudioContext | null = null;

function getAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    return audioCtx;
}

/**
 * 전역 볼륨 단계 (0=음소거 ~ 10=최대). 기존 소리 크기를 3단계로 보고,
 * 배율 = level/3 (3단계=기존, 10단계≈3.3배). localStorage에 저장.
 */
const VOLUME_KEY = 'gaia_sound_volume_level';
export const MAX_VOLUME_LEVEL = 10;
const DEFAULT_VOLUME_LEVEL = 3;

let volumeLevel: number = (() => {
    try {
        const raw = localStorage.getItem(VOLUME_KEY);
        const v = raw == null ? DEFAULT_VOLUME_LEVEL : Number(raw);
        return Number.isFinite(v) ? Math.max(0, Math.min(MAX_VOLUME_LEVEL, Math.round(v))) : DEFAULT_VOLUME_LEVEL;
    } catch {
        return DEFAULT_VOLUME_LEVEL;
    }
})();

export function getVolumeLevel(): number {
    return volumeLevel;
}

export function setVolumeLevel(n: number): void {
    volumeLevel = Math.max(0, Math.min(MAX_VOLUME_LEVEL, Math.round(n)));
    try { localStorage.setItem(VOLUME_KEY, String(volumeLevel)); } catch { /* ignore */ }
}

/** 볼륨 단계 → 게인 배율 (3단계=기존 크기, 0=무음). */
function volumeMultiplier(): number {
    return volumeLevel / DEFAULT_VOLUME_LEVEL;
}

/** 미리듣기용: 현재 볼륨으로 짧은 비프 1회. */
export function playVolumePreview() {
    playBeep(880, 0.12, 0.15);
}

/**
 * Plays a beep sound with a specified frequency, duration, and volume.
 */
function playBeep(frequency: number, duration: number, volume: number = 0.1) {
    try {
        const v = volume * volumeMultiplier();
        if (v <= 0) return; // 음소거(0단계)
        const ctx = getAudioContext();
        if (ctx.state === 'suspended') {
            ctx.resume();
        }

        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);

        // 게인 1.0 근처에서 클리핑/왜곡 방지로 0.8 상한
        gainNode.gain.setValueAtTime(Math.min(0.8, v), ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);

        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);

        oscillator.start();
        oscillator.stop(ctx.currentTime + duration);
    } catch (error) {
        console.warn('Failed to play sound:', error);
    }
}

/**
 * Sound for when it becomes the user's turn.
 * More prominent: a higher pitch double beep.
 */
export function playMyTurnSound() {
    // [사용자] 더 또렷하게 — 3음 상승 차임(A5→C#6→E6) + 볼륨 상향(0.15→0.3).
    playBeep(880, 0.12, 0.3);              // A5
    setTimeout(() => playBeep(1108.73, 0.12, 0.3), 130);  // C#6
    setTimeout(() => playBeep(1318.51, 0.2, 0.34), 260);  // E6 (마지막 강조)
}

/**
 * [사용자] 내가 '파워 충전 결정(누수 오퍼)'을 처리해야 할 때 — 놓치지 않게 또렷한 반복 벨.
 * 수동 수령(playPowerReceiveSound, 잔잔)과 구분되는 '띵-동 ×2' 주의 환기 패턴.
 */
export function playPowerDecisionSound() {
    playBeep(784, 0.12, 0.3);              // G5
    setTimeout(() => playBeep(1046.5, 0.16, 0.34), 150);  // C6
    setTimeout(() => playBeep(784, 0.12, 0.3), 360);      // G5
    setTimeout(() => playBeep(1046.5, 0.2, 0.34), 510);   // C6
}

/**
 * Sound for when it becomes someone else's turn.
 * Subtle: a lower pitch single beep.
 */
export function playOtherTurnSound() {
    playBeep(440, 0.1, 0.1); // A4
}

/**
 * Sound for an incoming chat message. Gentle, short rising two-note blip.
 */
export function playChatSound() {
    playBeep(587.33, 0.05, 0.08); // D5
    setTimeout(() => playBeep(783.99, 0.07, 0.08), 70); // G5
}

/**
 * Sound for when receiving power (passive income or charging).
 * Pleasant: a high pitch triple beep.
 */
export function playPowerReceiveSound() {
    const startFreq = 1318.51; // E6
    playBeep(startFreq, 0.05, 0.1);
    setTimeout(() => playBeep(startFreq * 1.25, 0.05, 0.1), 60);
    setTimeout(() => playBeep(startFreq * 1.5, 0.08, 0.1), 120);
}

/**
 * 부드러운 주의 알림 — 낮은 음역의 사인파 펄스를 두 번. 사이렌(triangle 왕복)이 "쨍하고 기분 나쁘다"는
 * 지적을 받아 교체했다(2026-08-20). 귀를 찌르는 성분을 없애는 게 요지:
 *   ① sine — 배음이 없어 날카로움이 안 생긴다(triangle/square는 고배음이 쨍함의 원인)
 *   ② lowpass 900Hz — 남은 고역까지 깎는다
 *   ③ 느린 어택(0.04s) — 시작의 '딱/쨍' 트랜지언트를 없애 부드럽게 들어온다
 *   ④ 낮은 음역(F4·C4) — 같은 음량에서 체감 자극이 훨씬 덜하다
 * 대신 '두 번 울린다'는 리듬으로 경고성을 유지한다.
 */
function playSoftPulses(freqs: number[], pulseSec: number, gapSec: number, volume: number) {
    try {
        const v = volume * volumeMultiplier();
        if (v <= 0) return; // 음소거(0단계)
        const ctx = getAudioContext();
        if (ctx.state === 'suspended') {
            ctx.resume();
        }

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(900, ctx.currentTime);
        filter.Q.setValueAtTime(0.7, ctx.currentTime);   // 공진 없이 완만하게
        filter.connect(ctx.destination);

        const peak = Math.min(0.8, v);
        freqs.forEach((f, i) => {
            const t0 = ctx.currentTime + i * (pulseSec + gapSec);
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(f, t0);
            gain.gain.setValueAtTime(0.0001, t0);
            gain.gain.linearRampToValueAtTime(peak, t0 + 0.04);              // 느린 어택
            gain.gain.setValueAtTime(peak, t0 + pulseSec * 0.55);
            gain.gain.exponentialRampToValueAtTime(0.001, t0 + pulseSec);    // 자연스러운 감쇠
            osc.connect(gain);
            gain.connect(filter);
            osc.start(t0);
            osc.stop(t0 + pulseSec + 0.02);
        });
    } catch (error) {
        console.warn('Failed to play pulses:', error);
    }
}

/**
 * [사용자 2026-08-20] 패스 확인창에 '아직 안 쓴 특수 액션' 경고가 떴을 때.
 * 변경 이력: 하강 2음("한 번 울려서 경고 같지 않다") → 사이렌 왕복("쨍하고 기분 나쁘다") → 지금(낮은 사인파 2펄스).
 * 놓치면 그 라운드 특수 액션이 사라지는 경고라 두 번 울리되, 음색은 부드럽게 둔다.
 * 음량은 알림음 설정을 따르고 0단계면 안 난다.
 */
export function playPassWarnSound() {
    playSoftPulses([349.23, 293.66], 0.26, 0.10, 0.22);   // F4 → D4 (완만한 하강 2펄스)
}

/**
 * 게임 종료 효과음(~3초). 볼륨 설정을 존중(playBeep 경유).
 * - 1등(isWinner): C5–E5–G5–C6 상승 아르페지오 + 마지막 C장3화음 지속(축하 팡파레).
 * - 그 외: 부드러운 2음 하강(중립 마무리).
 */
export function playEndSound(isWinner: boolean) {
    if (isWinner) {
        playBeep(523.25, 0.35, 0.16);                                   // C5
        setTimeout(() => playBeep(659.25, 0.35, 0.16), 180);            // E5
        setTimeout(() => playBeep(783.99, 0.35, 0.16), 360);            // G5
        setTimeout(() => playBeep(1046.5, 2.4, 0.18), 560);            // C6 (지속)
        setTimeout(() => playBeep(1318.51, 2.3, 0.09), 620);           // E6 (화음감)
        setTimeout(() => playBeep(1567.98, 2.3, 0.08), 660);           // G6 (화음감)
    } else {
        playBeep(392.0, 0.5, 0.1);                                      // G4
        setTimeout(() => playBeep(329.63, 1.2, 0.09), 400);            // E4
    }
}
