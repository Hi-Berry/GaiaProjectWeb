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
 * Plays a beep sound with a specified frequency, duration, and volume.
 */
function playBeep(frequency: number, duration: number, volume: number = 0.1) {
    try {
        const ctx = getAudioContext();
        if (ctx.state === 'suspended') {
            ctx.resume();
        }

        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);

        gainNode.gain.setValueAtTime(volume, ctx.currentTime);
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
