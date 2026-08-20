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

import { ALL_BONUS_TILES } from '@shared/gameConfig';

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
	[/^Academy \(/i, (d) => /qic/i.test(d) ? '아카데미 정큐받기' : /\d+\s*C\b/i.test(d) ? '아카데미 크레딧' : '아카데미 액션'],
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
	// [사용자 2026-08-20] '파워 액션'만 읽으면 무슨 액션인지 알 수 없다는 지적 → details로 갈라 읽는다.
	//   파워 액션 details는 `효과 (비용)` 형태다: `+3 Knowledge (4P)` (server/gameState.ts:8895 참고).
	//   못 알아본 값은 종전처럼 뭉뚱그려 읽어 무음이 되지는 않게 한다.
	[/^Power Action/i, (d) => {
		if (/Terraform/i.test(d)) return /2 Terraform/i.test(d) ? '파워 액션 테라포밍 2' : '파워 액션 테라포밍 1';
		if (/Knowledge/i.test(d)) return /3 Knowledge/i.test(d) ? '파워 액션 지식 3' : '파워 액션 지식 2';
		if (/Ore/i.test(d)) return '파워 액션 광석 2';
		if (/Credit/i.test(d)) return '파워 액션 크레딧 7';
		if (/Power token/i.test(d)) return '파워 액션 파워 토큰 2';
		return '파워 액션';
	}],
	// 기술 타일 액션 4종 — details: 'Gained 3 Knowledge' / 'Gained 1 QIC and 5 Credits' 등
	[/^Used Tech Action/i, (d) => {
		if (/Power/i.test(d)) return '기술 타일 파워 4';
		if (/Knowledge/i.test(d)) return '기술 타일 지식 3';
		if (/Ore/i.test(d)) return '기술 타일 광석 3';
		if (/QIC/i.test(d)) return '기술 타일 정큐 크레딧';
		return '기술 타일 액션';
	}],
	// 보너스 타일 액션 3종 — details: '1 Terraform Step' / 'Gaia Project' / '+3 Range'
	[/^Bonus Action/i, (d) => {
		if (/Terraform/i.test(d)) return '보너스 테라포밍';
		if (/Gaia/i.test(d)) return '보너스 가이아';
		if (/Range/i.test(d)) return '보너스 사거리';
		return '보너스 액션';
	}],
	[/^Federation$|^Formed Federation/i, '연방 형성'],
	[/^Ivits: Space Station/i, '우주 정거장 배치'],
	[/^Firaks: Downgrade/i, '다운그레이드'],
	[/^Ambas: Special/i, '의회 광산 교체'],
	[/^Lost Planet/i, '잊혀진 행성 배치'],
	// [사용자 2026-08-20] 타클론 파워 태우기·브레인스톤 이동은 무음 — 프리액션이고, 일반 `Power Burn`은
	//   이미 무음이라 타클론만 소리가 나는 게 앞뒤가 안 맞았다(사람 로그 60판에 281건). 이름도 틀렸다
	//   ('Taklons: Brain Stone'은 가이아 영역 이동이라 태우는 게 아니다). 뒤따르는 본 액션이 대신 읽힌다.
	[/Special$/i, '종족 특수 액션'],
	[/^Take.*Artifact|^Artifact/i, '인공물 획득'],
	[/^Pass|^pass_round/i, '패스'],
];

/**
 * [사용자 2026-08-20] 기술 타일은 '무엇을 먹고 어떤 트랙을 올렸는지'가 정보다 → 타일 이름을 읽는다.
 * 이름은 커뮤니티에서 부르는 대로 짧게 (tech-big-4str = '큰큰이'). 로그의 label은 'Big: 4Str' 같은
 * 약어라 그대로 읽으면 알아들을 수 없다.
 */
export const TECH_TILE_KO: Record<string, string> = {
	// 일반 기술 타일 9종
	'tech-inc-1o-1p': '수익 광석 파워',
	'tech-inc-4c': '수익 크레딧 4',
	'tech-inc-1k-1c': '수익 지식 크레딧',
	'tech-imm-7vp': '7점',
	'tech-imm-1k-planet': '행성별 지식',
	'tech-imm-1o-1q': '광석 정큐',
	'tech-gaia-3vp': '가이아 3점',
	'tech-big-4str': '큰큰이',
	'tech-act-4p': '파워 4 액션',
	// 고급 기술 타일 21종
	'adv-act-3k': '지식 3 액션',
	'adv-act-3o': '광석 3 액션',
	'adv-act-1q-5c': '정큐 크레딧 액션',
	'adv-vp-build-mine': '광산당 3점',
	'adv-vp-build-ts': '교역소당 3점',
	'adv-vp-research': '연구당 2점',
	'adv-vp-terraform': '테라포밍당 2점',
	'adv-vp-qic-action': '정큐 액션 4점',
	'adv-imm-1o-sector': '구역당 광석',
	'adv-imm-4vp-ts': '교역소 4점',
	'adv-imm-2vp-mine': '광산 2점',
	'adv-imm-2vp-sector': '구역 2점',
	'adv-imm-4vp-outer': '외곽 4점',
	'adv-imm-6vp-big': '큰건물 6점',
	'adv-imm-2vp-gaia': '가이아 2점',
	'adv-imm-5vp-fed': '연방 5점',
	'adv-pass-1vp-type': '패스 행성종류',
	'adv-pass-3vp-lab': '패스 연구소',
	'adv-pass-3vp-fed': '패스 연방',
	'adv-pass-2vp-asteroid': '패스 소행성',
	'adv-pass-2vp-outer': '패스 외곽',
	// 우주선 기술 타일 3종 — 배에서 얻거나 '기술 연방' 보상으로 들어온다
	'ship-tech-nav+1': '사거리 1',
	'ship-tech-1o3k': '광석 지식 3',
	'ship-tech-2tf-mine': '테라포밍 2 광산',
};

/**
 * [사용자 2026-08-20] 연방 보상은 '무엇을 받았나'가 정보다 — 로그 문구가 두 형식으로 섞여 있어
 *   ('+7VP +2O' 와 '7 VP 2O') 통째로 이름표를 만들지 못한다 → 숫자와 자원을 뽑아 조각으로 조합한다.
 */
function fedRewardParts(d: string): string[] {
	if (/tech tile/i.test(d)) return ['연방 보상', '기술타일'];
	if (/free mine/i.test(d)) return ['연방 보상', '무료 광산'];
	const out = ['연방 보상'];
	const vp = d.match(/(\d+)\s*VP/i)?.[1];
	if (vp) out.push(`${vp}점`);
	if (/\d\s*Q(IC)?\b/i.test(d)) out.push('정큐');
	if (/\d\s*O\b/i.test(d)) out.push('광석');
	if (/\d\s*C\b/i.test(d)) out.push('크레딧');
	if (/\d\s*K\b/i.test(d)) out.push('지식');
	if (/PW|Token/i.test(d)) out.push('토큰');
	return out;
}

/**
 * 조각 생성기가 읽어가는 목록 — 위 함수처럼 문구를 조립하는 경우는 정규식으로 찾을 수 없어 여기 적는다.
 * 점수는 실제 로그에 4·6·7·8·12점이 나오지만 변형 대비로 넉넉히 만든다(조각 하나 10KB).
 */
export const EXTRA_CLIP_PHRASES = [
	'연방 보상', '무료 광산', '보너스 타일',
	'2점', '3점', '4점', '5점', '6점', '7점', '8점', '9점', '10점', '11점', '12점',
	'정큐', '광석', '크레딧', '지식', '토큰',
];

/**
 * [사용자 2026-08-20] 패스할 때 고른 보너스 타일도 읽는다 — "패스"만으로는 무엇을 집었는지 모른다.
 * 수익(2C 등)보다 '무엇을 하는 타일인가'가 정보라서 액션·패스점수 쪽을 이름으로 삼았다.
 */
export const BONUS_TILE_KO: Record<string, string> = {
	'bon-2c-terraform': '테라포밍 액션',
	'bon-2pw-range3': '사거리 액션',
	'bon-2pw-gaiaproject': '가이아 프로젝트 액션',
	'bon-2c-1q': '크레딧 정큐',
	'bon-1o-1k': '광석 지식',
	'bon-1o-2tokens': '광석 토큰 2',
	'bon-4c-gaia': '가이아당 1점',
	'bon-1k-lab': '연구소당 3점',
	'bon-1o-ts': '교역소당 2점',
	'bon-4pw-bigbuilding': '큰건물당 4점',
	'bon-1o-mine': '광산당 1점',
	'bon-3c-bridge': '외곽 구역당 2점',
	'bon-1o-planettype': '행성종류당 1점',
	'bon-1o-gaiaformer': '남은 포머당 3점',
};

/** details 앞머리의 트랙 id를 '연구 경제'처럼 읽는다. 트랙 정보가 없으면 null. */
function trackPart(details: string): string | null {
	const m = (details || '').match(/([A-Za-z]+)\s*(?:→|stays)/);
	const t = m ? TRACK_KO[m[1].toLowerCase()] : null;
	return t ? `연구 ${t}` : null;
}

/**
 * [사용자 2026-08-20] '준비 동작' — 본 액션을 가능하게만 하는 것들.
 *
 * 왜 따로 두나: 안내는 한 턴에 한 번, 그 턴의 첫 액션만 읽는다. 그런데 사거리 보너스처럼
 *   "쓰고 나서 실제 행동을 하는" 것들이 그 1회를 먼저 써버려 정작 무엇을 했는지가 무음이 됐다
 *   (사용자 관찰: "거리 보너스 쓰고 우주선 입장해도 소리가 안 난다").
 *   → 이 라벨들은 안내는 하되 턴의 1회를 소모하지 않아, 뒤따르는 본 액션도 읽힌다.
 *
 * 파워 액션·티에프 테라포밍은 여기 넣지 않는다 — 그 자체가 알 만한 액션이고,
 * 사용자가 "앞에꺼만" 읽으라고 확정한 경우다.
 * 파워 태우기(타클론)는 여기가 아니라 아예 무음으로 뺐다 — 프리액션이라 읽을 것이 아니다.
 */
/**
 * '후속 정보' 로그 — 한 턴에 한 번 규칙을 넘어 따로 읽는다.
 * 기술 타일 획득·연방 보상처럼 앞선 액션의 결과지만 '무엇을 얻었나'가 정보인 것들.
 * 클라이언트·측정 도구가 같이 쓰는 단일 출처(예전엔 정규식을 각자 베껴 서로 어긋났다).
 */
export function isFollowupInfo(action: string): boolean {
	return /Gained Tech Tile$|^Advanced Tech Tile|^Federation Reward|^Ship Tech:|^Eclipse: Research|^Advanced Tech: Advanced track/i.test(action || '');
}

export const ENABLER_LABELS = new Set(['보너스 사거리', '트왈라잇 사거리']);

/**
 * 로그 항목 → 재생할 조각 배열(호칭 제외). 기술 타일만 조각이 여러 개다.
 *
 * 왜 조각으로 나누나: '기술타일 큰큰이 연구 경제'를 한 문구로 만들면 타일 30종 × 트랙 6종 =
 *   180개 mp3가 필요하다. 머리말·타일·트랙을 따로 두면 32개로 끝난다(조각 이어붙이기는 이미 검증됨).
 */
export function actionParts(action: string, details: string, tileId?: string): string[] | null {
	const a = (action || '').trim();
	const d = details || '';
	const isAdv = /^Advanced Tech Tile/i.test(a);
	if (isAdv || /Gained Tech Tile$/i.test(a)) {
		// 고급 타일 로그는 details가 'Covered tech-xxx → adv-yyy'라 앞의 tech-를 잡으면 안 된다.
		// 봇 로그는 tileId 없이 details에만 id가 들어온다 → 양쪽 다 본다.
		const id = tileId || (isAdv ? d.match(/(adv-[a-z0-9-]+)/i)?.[1] : d.match(/((?:tech|adv)-[a-z0-9-]+)/i)?.[1]) || '';
		const name = TECH_TILE_KO[id];
		const parts = [isAdv ? '고급 기술타일' : '기술타일', name, trackPart(d)];
		return parts.filter(Boolean) as string[];
	}
	// [사용자 2026-08-20] 고른 트랙만 다음 줄에 남는 액션들 — 앞줄은 "이클립스 연구"까지만 읽어
	//   무엇을 올렸는지 알 수 없었다. 연구소 건설처럼 이어 읽는다(사람 로그 2,017건).
	if (/^Eclipse: Research|^Advanced Tech: Advanced track/i.test(a)) {
		const t = trackPart(d);
		return t ? [t] : null;
	}
	// 연방 보상 — '연방 형성' 다음 줄에 어떤 보상을 집었는지 남는다(사용자 요청).
	if (/^Federation Reward/i.test(a)) return fedRewardParts(d);
	// 우주선 기술 타일: 얻은 즉시 효과가 'Ship Tech: <라벨>'로, 트랙 전진은 'Ship Tech: Advanced track'으로 남는다.
	//   기술 연방 보상이 이 경로라 연구소 건설처럼 '타일 + 트랙'까지 이어 읽는다.
	if (/^Ship Tech: Advanced track/i.test(a)) {
		const t = trackPart(d);
		return t ? [t] : null;
	}
	if (/^Ship Tech:/i.test(a)) {
		const id = /2tf\+?mine/i.test(a) ? 'ship-tech-2tf-mine' : /1o ?3k/i.test(a) ? 'ship-tech-1o3k' : /nav/i.test(a) ? 'ship-tech-nav+1' : '';
		const name = TECH_TILE_KO[id];
		return name ? ['기술타일', name] : null;
	}
	/* [버그수정 2026-08-20] 'Selected Bonus Tile'은 게임 시작 때 첫 보너스 타일을 고르는 로그다.
	   아래 'Selected Bonus'(패스) 규칙에 걸려 "패스"로 읽혔다(실제 봇 대국 확인).
	   details가 id가 아니라 라벨('4P | 4VP/Big')이라 공유 설정에서 id를 찾아 이름을 붙인다. */
	if (/^Selected Bonus Tile/i.test(a)) {
		// 라벨을 못 찾으면 id가 그대로 들어온 경우다(서버 폴백: `tile?.label || bonusTileId`)
		const id = ALL_BONUS_TILES.find((t) => t.label === d.trim())?.id ?? d.trim();
		const name = BONUS_TILE_KO[id];
		return name ? ['보너스 타일', name] : null;
	}
	// 패스 로그는 action이 'Selected Bonus'다(details: 'Returned bon-x, took bon-y').
	// 6라운드는 새 타일을 안 집으므로 details가 없다 → '패스'만 읽는다.
	if (/^Selected Bonus/i.test(a)) {
		const took = d.match(/took\s+(bon-[a-z0-9-]+)/i)?.[1];
		const name = took ? BONUS_TILE_KO[took] : undefined;
		return name ? ['패스', name] : ['패스'];
	}
	const label = actionLabel(a, d);
	return label ? [label] : null;
}

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
