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
    playBeep(880, 0.1, 0.15); // A5
    setTimeout(() => {
        playBeep(1108.73, 0.15, 0.15); // C#6
    }, 120);
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
