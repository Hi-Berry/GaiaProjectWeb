"""
액션 음성 안내용 mp3 조각 생성기 (2026-08-20).

왜 미리 뽑나: 브라우저 내장 TTS(speechSynthesis)는 기기마다 음성 세대가 달라 윈도우 크롬에서는
  기계음처럼 들린다(사용자 지적). 읽을 문구가 '닫힌 집합'이라 미리 만들어 두면 어디서나 같은
  신경망 음성이 난다 — 실행 중 네트워크·API·비용 0, 오프라인 동작.

조합 폭발 회피: 통문장이면 종족 18 × 액션 36 = 648개가 필요하지만, '종족'과 '액션'을 따로 뽑아
  이어 재생하면 54개로 끝난다(사용자 청취 확인: 이음새 어색함 없음).

문구 출처는 client/src/lib/speech.ts 하나 — 여기서 정규식으로 뽑아 쓴다(두 곳에 적으면 갈라진다).
  누락되면 클라이언트가 그 문구만 기기 TTS로 대체하므로 조용히 깨지지는 않는다.

사용:
  pip install edge-tts
  python scripts/genVoiceClips.py            # 두 목소리 전부
  python scripts/genVoiceClips.py --voice f  # 여성만
"""
import asyncio
import hashlib
import json
import os
import re
import sys

import edge_tts

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEECH_TS = os.path.join(ROOT, 'client', 'src', 'lib', 'speech.ts')
OUT_DIR = os.path.join(ROOT, 'client', 'public', 'voice')

VOICES = {
    'f': ('ko-KR-SunHiNeural', 'female'),
    'm': ('ko-KR-InJoonNeural', 'male'),
}
RATE = '+15%'   # 판당 수십 번 들으므로 조금 빠르게 (사용자 확인)

TRACKS = ['테라포밍', '거리', '인공지능', '가이아', '경제', '과학']


def collect_phrases() -> list[str]:
    """speech.ts에서 종족명·액션 라벨을 뽑는다."""
    src = open(SPEECH_TS, encoding='utf-8').read()

    # 종족: FACTION_VOICE_KO 값들
    m = re.search(r'FACTION_VOICE_KO[^{]*\{(.*?)\n\};', src, re.S)
    factions = re.findall(r":\s*'([^']+)'", m.group(1)) if m else []

    # 액션: RULES 배열 안의 '한글이 든 모든 문자열'을 라벨로 본다.
    # [수정 2026-08-20] 예전엔 `, '라벨']` 형태만 잡아 삼항 연산자 안의 문구(아카데미 큐익/크레딧/액션)를
    #   놓쳤다 → 조각이 안 만들어지고 그 안내만 기기 TTS로 대체됐다. 주석을 걷어내고 전부 긁는다.
    m2 = re.search(r"const RULES[^\[]*\[(.*?)\n\];", src, re.S)
    body = m2.group(1) if m2 else ''
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)      # 블록 주석
    body = re.sub(r"//[^\n]*", "", body)                   # 줄 주석
    labels = [t for t in re.findall(r"'([^']+)'", body) if re.search(r"[가-힣]", t)]

    # 탑승은 `${SHIP_KO(d)} 탑승` 형태라 배 이름 4종 + 조합을 직접 만든다
    ships = ['리벨리온', '트왈라잇', '이클립스', '티에프', '우주선']
    labels += [f'{s} 탑승' for s in ships]
    labels += [f'연구 {t}' for t in TRACKS]

    seen, out = set(), []
    for p in factions + labels:
        p = p.strip()
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return out


def key_of(text: str) -> str:
    return hashlib.sha1(text.encode('utf-8')).hexdigest()[:10]


async def gen(voice_id: str, folder: str, phrases: list[str]) -> dict:
    d = os.path.join(OUT_DIR, folder)
    os.makedirs(d, exist_ok=True)
    manifest = {}
    for i, text in enumerate(phrases, 1):
        k = key_of(text)
        path = os.path.join(d, k + '.mp3')
        if not os.path.exists(path):
            await edge_tts.Communicate(text, voice_id, rate=RATE).save(path)
        manifest[text] = k
        print(f'  [{i:2}/{len(phrases)}] {text}  →  {folder}/{k}.mp3  ({os.path.getsize(path)}B)')
    return manifest


async def main():
    which = sys.argv[sys.argv.index('--voice') + 1] if '--voice' in sys.argv else 'fm'
    phrases = collect_phrases()
    print(f'문구 {len(phrases)}개 · 목소리 {which}\n')
    manifest = {'rate': RATE, 'phrases': {}}
    for code in which:
        vid, folder = VOICES[code]
        print(f'== {folder} ({vid}) ==')
        manifest['phrases'] = await gen(vid, folder, phrases)
        manifest.setdefault('voices', []).append(folder)
    with open(os.path.join(OUT_DIR, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(',', ':'))
    total = sum(
        os.path.getsize(os.path.join(OUT_DIR, v, f))
        for v in manifest['voices'] for f in os.listdir(os.path.join(OUT_DIR, v))
    )
    print(f'\n완료 — 조각 {len(phrases)}개 × 목소리 {len(manifest["voices"])}종 · 총 {total/1024:.0f}KB')
    print(f'manifest: client/public/voice/manifest.json')


asyncio.run(main())
