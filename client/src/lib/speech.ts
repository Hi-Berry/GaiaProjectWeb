/**
 * [사용자 2026-08-20] 액션 음성 안내 — "발타크 교역소 건설"처럼 방금 끝난 턴의 행동을 읽어준다.
 *
 * 언제 말하나: **턴이 다음 사람으로 넘어가는 순간에 한 번만.** 로그 한 줄마다 읽으면
 *   프리액션·되돌리기·파워 수신까지 쏟아져 혼란스럽다는 사용자 판단(액션 완료 시점만).
 *
 * 어떻게: 브라우저 내장 speechSynthesis(음성 파일·서버·라이브러리 0). 합성은 OS TTS 엔진이 하므로
 *   JS 스레드를 막지 않고, 꺼져 있으면 isOn() 한 줄로 빠져나온다.
 *
 * 제약(브라우저 정책):
 *   - 첫 소리는 사용자 제스처 뒤에만 난다 → primeSpeech()를 첫 탭에서 한 번 호출해 잠금 해제.
 *   - iOS는 무음 스위치가 켜져 있으면 안 들린다(미디어 소리 취급). 백그라운드 탭에선 멈춘다.
 *   - 안드로이드는 getVoices()가 비동기라 처음 비어 있을 수 있어 voiceschanged로 다시 채운다.
 */

export const VOICE_KEY = 'action-voice';          // 'on' | 'off'(기본)
export const VOICE_RATE_KEY = 'action-voice-rate'; // 0.8 ~ 2.0
export const VOICE_WHO_KEY = 'action-voice-who';   // 'faction'(기본) | 'player'
export const VOICE_NAME_KEY = 'action-voice-name'; // 기기 TTS를 쓸 때 고른 음성 이름
export const VOICE_STYLE_KEY = 'action-voice-style'; // 'female'(기본) | 'male' | 'device'

/** 목소리 종류 — female/male은 미리 만든 신경망 mp3 조각, device는 브라우저 내장 TTS. */
export type VoiceStyle = 'female' | 'male' | 'device';

export function getVoiceStyle(): VoiceStyle {
	try {
		const v = localStorage.getItem(VOICE_STYLE_KEY);
		return v === 'male' || v === 'device' ? v : 'female';
	} catch { return 'female'; }
}

export function setVoiceStyle(v: VoiceStyle): void {
	try { localStorage.setItem(VOICE_STYLE_KEY, v); } catch { /* noop */ }
}

/** 누구 이름으로 부를지 — 종족명("발타크 교역소 건설") vs 사람 이름("시리 교역소 건설") */
export type VoiceWho = 'faction' | 'player';

export function getVoiceWho(): VoiceWho {
	try { return localStorage.getItem(VOICE_WHO_KEY) === 'player' ? 'player' : 'faction'; } catch { return 'faction'; }
}

export function setVoiceWho(w: VoiceWho): void {
	try { localStorage.setItem(VOICE_WHO_KEY, w); } catch { /* noop */ }
}

const supported = () =>
	typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined'
	&& typeof window.SpeechSynthesisUtterance !== 'undefined';

export function isVoiceOn(): boolean {
	if (!supported()) return false;
	try { return localStorage.getItem(VOICE_KEY) === 'on'; } catch { return false; }
}

export function setVoiceOn(on: boolean): void {
	try { localStorage.setItem(VOICE_KEY, on ? 'on' : 'off'); } catch { /* noop */ }
	window.dispatchEvent(new CustomEvent('action-voice-change', { detail: on }));
	if (!on) try { window.speechSynthesis.cancel(); } catch { /* noop */ }
}

export function getVoiceRate(): number {
	try {
		const v = Number(localStorage.getItem(VOICE_RATE_KEY));
		return v >= 0.8 && v <= 2 ? v : 1.4;   // 기본 1.4 — 판당 수십 번 들으므로 기본 속도는 느리다
	} catch { return 1.4; }
}

export function setVoiceRate(v: number): void {
	try { localStorage.setItem(VOICE_RATE_KEY, String(v)); } catch { /* noop */ }
}

/** 한국어 음성 캐시 — 안드로이드에서 getVoices()가 첫 호출에 느리거나 비어 있다. */
let koVoice: SpeechSynthesisVoice | null = null;
let voiceLookupDone = false;

/**
 * 음성 품질 점수 — [사용자 2026-08-20] "기계음 같아 듣기 힘들다"는 지적.
 * 원인은 '첫 번째 한국어 음성'을 그냥 집던 것. 같은 기기에도 세대가 다른 음성이 섞여 있다:
 *   Windows: Heami Desktop(구형 SAPI5, 가장 기계음) < Heami(OneCore) < SunHi Online Natural(엣지, 신경망)
 *   Android: 기기 기본 < Google 한국어  ·  iOS: 유나
 * 이름으로 세대를 판별해 가장 좋은 것을 기본으로 쓴다.
 */
function voiceScore(v: SpeechSynthesisVoice): number {
	const n = (v.name || '').toLowerCase();
	if (/natural|neural/.test(n)) return 100;   // 신경망(엣지 Online Natural 등)
	if (/online/.test(n)) return 90;
	if (/google/.test(n)) return 80;
	if (/yuna|유나/.test(n)) return 75;         // iOS
	if (/desktop/.test(n)) return 10;           // 구형 SAPI5 — 가장 기계음
	return v.localService ? 50 : 70;            // 원격 음성이 대개 더 자연스럽다
}

/** 쓸 수 있는 한국어 음성 — 품질 좋은 순 */
export function listKoVoices(): SpeechSynthesisVoice[] {
	if (!supported()) return [];
	return (window.speechSynthesis.getVoices() || [])
		.filter((v) => (v.lang || '').toLowerCase().startsWith('ko'))
		.sort((a, b) => voiceScore(b) - voiceScore(a));
}

export function getVoiceName(): string {
	try { return localStorage.getItem(VOICE_NAME_KEY) || ''; } catch { return ''; }
}

export function setVoiceName(name: string): void {
	try { localStorage.setItem(VOICE_NAME_KEY, name); } catch { /* noop */ }
	koVoice = null;
	voiceLookupDone = false;
	pickKoVoice();
}

function pickKoVoice(): SpeechSynthesisVoice | null {
	if (!supported()) return null;
	const ko = listKoVoices();
	if (!ko.length) return null;
	voiceLookupDone = true;
	const chosen = getVoiceName();
	koVoice = (chosen && ko.find((v) => v.name === chosen)) || ko[0];   // 고른 게 없으면 품질 1순위
	return koVoice;
}

if (supported()) {
	pickKoVoice();
	window.speechSynthesis.onvoiceschanged = () => { pickKoVoice(); };
}

/** 첫 사용자 제스처에서 한 번 호출 — 이후 자동 재생이 허용된다(무음 utterance로 잠금만 푼다). */
let primed = false;
export function primeSpeech(): void {
	if (primed || !supported() || !isVoiceOn()) return;
	primed = true;
	try {
		const u = new SpeechSynthesisUtterance(' ');
		u.volume = 0;
		window.speechSynthesis.speak(u);
	} catch { /* noop */ }
}

/**
 * 미리 만든 mp3 조각 재생 (client/public/voice) — 기기 TTS가 윈도우 크롬에서 기계음이라는 지적에 대한 답.
 * 조각은 '종족'과 '액션'을 따로 뽑아 이어 붙인다(통문장이면 18×36=648개, 조각이면 64개).
 * manifest는 문구 → 파일키 매핑. 조각이 하나라도 없으면 그 안내만 기기 TTS로 대체한다.
 */
type Manifest = { phrases: Record<string, string>; voices?: string[] };
let manifest: Manifest | null = null;
let manifestTried = false;

async function loadManifest(): Promise<Manifest | null> {
	if (manifest || manifestTried) return manifest;
	manifestTried = true;
	try {
		const res = await fetch('/voice/manifest.json', { cache: 'force-cache' });
		if (res.ok) manifest = await res.json();
	} catch { /* 조각이 없으면 기기 TTS로 */ }
	return manifest;
}

let playSeq = 0;                      // 최신 안내만 남기기 위한 토큰
let audioEl: HTMLAudioElement | null = null;

function stopClips(): void {
	playSeq++;
	if (audioEl) { try { audioEl.pause(); } catch { /* noop */ } audioEl = null; }
}

/** 조각들을 순서대로 재생. 중간에 새 안내가 오면(seq 변경) 즉시 중단. */
async function playClips(keys: string[], folder: string, rate: number): Promise<void> {
	const my = ++playSeq;
	for (const k of keys) {
		if (my !== playSeq) return;
		await new Promise<void>((resolve) => {
			const a = new Audio(`/voice/${folder}/${k}.mp3`);
			a.playbackRate = rate;
			audioEl = a;
			const done = () => { a.onended = null; a.onerror = null; resolve(); };
			a.onended = done;
			a.onerror = done;
			a.play().catch(done);   // 자동재생 차단 시에도 멈추지 않게
		});
	}
	if (my === playSeq) audioEl = null;
}

/**
 * 안내 큐 — [사용자 2026-08-20] "혼자 남아 연속으로 액션하면 하나씩 울려야 하는데 마지막에 한 번만 난다".
 *   원인은 '현재 플레이어 변경'을 트리거로 쓴 것. 이제 로그에 메인 액션이 붙을 때마다 안내를 넣으므로
 *   연속 액션에서 안내가 겹칠 수 있다 → 큐에 쌓아 순서대로 재생한다.
 *   너무 밀리면 옛 안내는 버린다(현재 상황과 어긋난 소리가 계속 나오는 게 더 나쁘다).
 */
const MAX_QUEUE = 3;
const queue: string[][] = [];
let draining = false;

export function enqueueParts(parts: string[]): void {
	const list = parts.filter(Boolean);
	if (!list.length || !isVoiceOn()) return;
	queue.push(list);
	while (queue.length > MAX_QUEUE) queue.shift();
	if (!draining) void drain();
}

async function drain(): Promise<void> {
	draining = true;
	while (queue.length) {
		const parts = queue.shift()!;
		await speakOnce(parts);
	}
	draining = false;
}

/** 한 건을 끝까지 재생(조각이면 파일 순서대로, 기기 TTS면 utterance 종료까지 대기). */
function speakOnce(list: string[]): Promise<void> {
	const style = getVoiceStyle();
	if (style === 'device') {
		return new Promise<void>((resolve) => {
			if (!supported()) { resolve(); return; }
			try {
				if (!voiceLookupDone) pickKoVoice();
				const u = new SpeechSynthesisUtterance(list.join(', '));
				u.lang = 'ko-KR';
				u.rate = getVoiceRate();
				if (koVoice) u.voice = koVoice;
				u.onend = () => resolve();
				u.onerror = () => resolve();
				window.speechSynthesis.speak(u);
			} catch { resolve(); }
		});
	}
	return loadManifest().then((m) => {
		const keys = m ? list.map((t) => m.phrases?.[t]).filter(Boolean) as string[] : [];
		if (m && keys.length === list.length) {
			const rate = Math.max(0.7, Math.min(1.6, 0.75 + (getVoiceRate() - 1) * 0.5));
			return playClips(keys, style, rate);
		}
		speak(list.join(', '));   // 조각 누락 → 기기 TTS 대체(대기 없이)
	});
}

/**
 * 안내 재생(즉시) — 설정 미리듣기용. 재생 중인 것을 끊고 바로 들려준다.
 * 게임 중 안내는 enqueueParts를 쓴다.
 *
 * 안내 재생 — 조각(여성/남성)이 가능하면 조각으로, 아니면 기기 TTS로.
 * parts 예: ['발타크', '티에프 테라포밍', '광산 건설']
 */
export function speakParts(parts: string[]): void {
	const list = parts.filter(Boolean);
	if (!list.length || !isVoiceOn()) return;
	const style = getVoiceStyle();
	if (style === 'device') { speak(list.join(', ')); return; }

	void loadManifest().then((m) => {
		const keys = m ? list.map((t) => m.phrases?.[t]).filter(Boolean) as string[] : [];
		if (m && keys.length === list.length) {
			// 조각 속도: 파일이 이미 +15%라 슬라이더 1.4는 과하다 → 1.0 기준으로 완만하게 환산
			const rate = Math.max(0.7, Math.min(1.6, 0.75 + (getVoiceRate() - 1) * 0.5));
			stopClips();
			void playClips(keys, style, rate);
		} else {
			speak(list.join(', '));   // 조각 누락 → 기기 TTS 대체
		}
	});
}

/** 말하기 — 턴은 몇 초 단위로 넘어가므로 밀린 문장은 버리고(cancel) 최신 것만 읽는다. */
export function speak(text: string): void {
	if (!text || !supported() || !isVoiceOn()) return;
	try {
		stopClips();
		if (!voiceLookupDone) pickKoVoice();
		window.speechSynthesis.cancel();
		const u = new SpeechSynthesisUtterance(text);
		u.lang = 'ko-KR';
		u.rate = getVoiceRate();
		if (koVoice) u.voice = koVoice;
		window.speechSynthesis.speak(u);
	} catch { /* 음성은 부가기능 — 실패해도 게임에 영향 없음 */ }
}

/** 종족 한글명 (읽기용 — 표기는 영문이지만 음성은 한글이 자연스럽다) */
export const FACTION_VOICE_KO: Record<string, string> = {
	// [사용자 2026-08-20] 실제로 부르는 이름으로 교정. 음성은 매 턴 들리므로 짧은 통칭이 맞다.
	terran: '테란', lantids: '란티다', hadsch_hallas: '하드쉬', ivits: '하이브',
	geodens: '기오덴', bal_tak: '발타크', xenos: '제노스', gleens: '글린',
	taklons: '타클론', ambas: '엠바스', bescods: '메안', firaks: '파이락',
	itars: '아이타', nevlas: '네블라', moweyip: '모웨', space_giants: '스자',
	tinkeroids: '팅커', darkanians: '다카',
};

const TRACK_KO: Record<string, string> = {
	terraforming: '테라포밍', navigation: '거리', artificialintelligence: '인공지능',
	gaiaproject: '가이아', economy: '경제', science: '과학',
};

/** 탑승 로그의 details에서 배 이름을 읽는다 — "Rebellion · 10VP → 5VP (-5)" 형태. */
const SHIP_KO = (d: string): string => {
	if (/rebellion/i.test(d)) return '리벨리온';
	if (/twilight/i.test(d)) return '트왈라잇';
	if (/eclipse/i.test(d)) return '이클립스';
	if (/tf ?mars/i.test(d)) return '티에프';
	return '우주선';
};

/**
 * 메인 액션만 읽는다 — 여기 안 걸리는 로그(프리액션·파워 수신·되돌리기·라운드 시작·
 * 그리고 '기술타일 획득'처럼 다른 액션의 결과로 붙는 항목)는 무음.
 * 순서 주의: 위에서 아래로 첫 일치를 쓴다(예: 'Built Mine on Asteroid'가 'Built Mine'보다 먼저).
 */
const RULES: Array<[RegExp, string | ((d: string) => string)]> = [
	[/^Built Mine on Asteroid|^Eclipse: Built mine on asteroid/i, '소행성 광산 건설'],
	[/^Built Mine on Proto/i, '원시행성 광산 건설'],
	[/^Built Parasitic Mine/i, '기생 광산 건설'],
	[/^Built Mine/i, '광산 건설'],
	[/^Upgraded to Trading Station/i, '교역소 건설'],
	[/^Upgraded to Research Lab/i, '연구소 건설'],
	[/^Upgraded to Planetary Institute/i, '의회 건설'],
	// [버그수정 2026-08-20] `Academy (Right)`는 건설이 아니라 **특수 액션**(details: '1 QIC (Special Action)')이다.
	//   예전 규칙이 ^Academy\( 까지 건설로 잡아 QIC를 받아도 "아카데미 건설"이 나왔다(사용자 관찰).
	[/^Academy \(/i, (d) => /qic/i.test(d) ? '아카데미 큐익' : /\d+\s*C\b/i.test(d) ? '아카데미 크레딧' : '아카데미 액션'],
	[/^Upgraded to Academy/i, '아카데미 건설'],
	[/^Advanced TS built/i, '고급 교역소 건설'],
	[/^Advanced Research/i, (d) => {
		const m = d.match(/^([A-Za-z]+)/);
		const t = m ? TRACK_KO[m[1].toLowerCase()] : null;
		return t ? `연구 ${t}` : '연구 진행';
	}],
	[/^Placed Gaiaformer/i, '가이아포머 배치'],
	// 탑승은 어느 배인지 details("Rebellion · 10VP → 5VP")에서 읽는다
	[/^Entered Ship/i, (d) => `${SHIP_KO(d)} 탑승`],

	// 우주선 액션 12종 (배 4척 × 3) — 로그 문구가 액션마다 달라 그대로 갈라 읽는다.
	// 결과성 항목(Gained Tech Tile · Research · Built mine on asteroid · Spaceship Fed · Ship Tech:*)은
	// 아래 어느 규칙에도 안 걸리게 두어 무음 처리 → 본 액션이 대신 읽힌다.
	[/^Rebellion:\s*\d*K?\s*→/i, '리벨리온 자원 변환'],
	[/^Rebellion: Gain tech tile/i, '리벨리온 기술타일'],
	[/^Rebellion: Mine → TS/i, '리벨리온 교역소 건설'],
	[/^Twilight: TS → Research Lab/i, '트왈라잇 연구소 건설'],
	[/^Twilight: \+?\d* ?Range/i, '트왈라잇 사거리'],
	[/^Twilight: Federation benefit/i, '트왈라잇 연방 보상'],
	[/^Eclipse:.*→ Research/i, '이클립스 연구'],
	[/^Eclipse:.*Build mine on asteroid/i, '이클립스 소행성 광산'],
	[/^Eclipse: Planet types/i, '이클립스 행성 점수'],
	[/^TF Mars: Gaia Project/i, '티에프 가이아'],
	[/^TF Mars:.*Terraform/i, '티에프 테라포밍'],
	[/^TF Mars: Tech tiles/i, '티에프 기술타일 점수'],
	[/^Power Action/i, '파워 액션'],
	[/^Used Tech Action/i, '기술 타일 액션'],
	[/^Bonus Action/i, '보너스 액션'],
	[/^Federation$|^Formed Federation/i, '연방 형성'],
	[/^Ivits: Space Station/i, '우주 정거장 배치'],
	[/^Firaks: Downgrade/i, '다운그레이드'],
	[/^Ambas: Special/i, '의회 광산 교체'],
	[/^Lost Planet/i, '잊혀진 행성 배치'],
	[/^Taklons: Burn|^Taklons: Brain/i, '파워 태우기'],
	[/Special$/i, '종족 특수 액션'],
	[/^Take.*Artifact|^Artifact/i, '인공물 획득'],
	[/^Pass|^pass_round/i, '패스'],
];

/** 로그 항목 → 액션 라벨(호칭 없음). 메인 액션이 아니면 null. */
export function actionLabel(action: string, details: string): string | null {
	const a = (action || '').trim();
	if (!a) return null;
	for (const [re, out] of RULES) {
		if (!re.test(a)) continue;
		return typeof out === 'function' ? out(details || '') : out;
	}
	return null;
}

/**
 * 호칭 — 종족명 또는 사람 이름.
 * 조각 모드(female/male)에는 사람 이름 조각이 없으므로 종족명으로 고정한다(사용자 확인: 이름은 불필요).
 */
export function whoLabel(factionId?: string, playerName?: string): string | null {
	const fac = factionId ? FACTION_VOICE_KO[factionId] ?? null : null;
	if (getVoiceStyle() !== 'device') return fac || playerName || null;
	return getVoiceWho() === 'player' ? (playerName || fac) : (fac || playerName) || null;
}

/** 로그 항목 → 읽을 문구(호칭 포함). 스모크 테스트·기기 TTS 경로용. */
export function actionPhrase(action: string, details: string, factionId?: string, playerName?: string): string | null {
	const label = actionLabel(action, details);
	if (!label) return null;
	const who = whoLabel(factionId, playerName);
	return who ? `${who} ${label}` : label;
}
