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

function pickKoVoice(): SpeechSynthesisVoice | null {
	if (!supported()) return null;
	const vs = window.speechSynthesis.getVoices() || [];
	if (!vs.length) return null;
	voiceLookupDone = true;
	koVoice = vs.find((v) => (v.lang || '').toLowerCase().startsWith('ko')) ?? null;
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

/** 말하기 — 턴은 몇 초 단위로 넘어가므로 밀린 문장은 버리고(cancel) 최신 것만 읽는다. */
export function speak(text: string): void {
	if (!text || !supported() || !isVoiceOn()) return;
	try {
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
	[/^Upgraded to Academy|^Academy \(/i, '아카데미 건설'],
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

/**
 * 로그 항목 → 읽을 문구. 메인 액션이 아니면 null.
 * 호칭은 설정(getVoiceWho)에 따라 종족명 또는 사람 이름. 고른 쪽이 비어 있으면 다른 쪽으로 대체한다.
 */
export function actionPhrase(action: string, details: string, factionId?: string, playerName?: string): string | null {
	const a = (action || '').trim();
	if (!a) return null;
	for (const [re, out] of RULES) {
		if (!re.test(a)) continue;
		const label = typeof out === 'function' ? out(details || '') : out;
		const fac = factionId ? FACTION_VOICE_KO[factionId] : null;
		const who = getVoiceWho() === 'player' ? (playerName || fac) : (fac || playerName);
		return who ? `${who} ${label}` : label;
	}
	return null;
}
