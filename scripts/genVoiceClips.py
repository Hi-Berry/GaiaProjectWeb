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
MIN_BYTES = 2000  # 이보다 작은 mp3는 생성 실패로 봄(가장 짧은 '패스'도 10KB다)
BAD: list[str] = []  # 끝까지 못 받은 조각 목록

# [사용자 2026-08-20] +15%였는데 "엄청 빨리 말할려고 하는 느낌"이라는 지적.
#   짧은 문구("교역소 건설")엔 맞았지만 문구가 길어지며 과하게 압축됐다 —
#   실측: '파워 액션 크레딧 7'이 8글자 1.11초(패스 2글자 0.73초). 보통 속도로 되돌린다.
#   더 빠르게 듣고 싶으면 설정의 속도 슬라이더로 올린다(재생 배속).
RATE = '+0%'

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

    # 기술 타일 이름(TECH_TILE_KO) + 머리말 — RULES 밖에 있어 따로 뽑는다.
    #   '기술타일'/'고급 기술타일' + 타일이름 + '연구 <트랙>' 3조각으로 읽으므로 조합 문구는 만들지 않는다
    #   (통문장이면 타일 30 × 트랙 6 = 180개).
    m3 = re.search(r"TECH_TILE_KO[^{]*[{](.*?)[}];", src, re.S)
    tiles = re.findall(r":\s*'([^']+)'", m3.group(1)) if m3 else []
    labels += ['기술타일', '고급 기술타일'] + tiles

    # 보너스 타일 이름(BONUS_TILE_KO) — 패스할 때 '패스' + 타일이름 2조각으로 읽는다
    m4 = re.search(r"BONUS_TILE_KO[^{]*[{](.*?)[}];", src, re.S)
    labels += re.findall(r":\s*'([^']+)'", m4.group(1)) if m4 else []

    # 조립형 문구 목록(EXTRA_CLIP_PHRASES) — 연방 보상처럼 숫자·자원을 붙여 만드는 것들
    m5 = re.search(r"EXTRA_CLIP_PHRASES[^\[]*\[(.*?)\];", src, re.S)
    labels += re.findall(r"'([^']+)'", m5.group(1)) if m5 else []

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
    # [버그수정 2026-08-20] 예전엔 문구만 해시했다 → 말 속도를 바꿔도 파일명이 그대로여서
    #   이미 접속했던 사람은 브라우저 캐시의 옛 소리를 계속 듣는다. 속도를 해시에 넣어
    #   내용이 바뀌면 파일명도 바뀌게 한다(옛 파일은 매니페스트에 없어 자동 정리된다).
    return hashlib.sha1(f'{text}|{RATE}'.encode('utf-8')).hexdigest()[:10]


async def gen(voice_id: str, folder: str, phrases: list[str]) -> dict:
    d = os.path.join(OUT_DIR, folder)
    os.makedirs(d, exist_ok=True)
    manifest = {}
    for i, text in enumerate(phrases, 1):
        k = key_of(text)
        path = os.path.join(d, k + '.mp3')
        # [버그수정 2026-08-20] edge-tts가 간혹 빈 응답을 줘 0바이트 mp3가 저장된다(실측 113건 중 1건).
        #   '이미 있으면 건너뛴다'만 보면 다시 돌려도 그 조각은 영구히 빈 파일로 남고, 클라이언트는
        #   onerror로 그냥 넘어가므로 그 단어만 조용히 빠진다(눈에 안 띄는 종류의 고장).
        #   → 너무 작은 파일은 없는 것으로 보고 다시 받는다.
        for _ in range(3):
            if os.path.exists(path) and os.path.getsize(path) >= MIN_BYTES:
                break
            await edge_tts.Communicate(text, voice_id, rate=RATE).save(path)
        size = os.path.getsize(path)
        if size < MIN_BYTES:
            BAD.append(f'{folder}/{text}')
        manifest[text] = k
        print(f'  [{i:2}/{len(phrases)}] {text}  →  {folder}/{k}.mp3  ({size}B)' + ('  ← 빈 파일!' if size < MIN_BYTES else ''))
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
    # 문구를 바꾸면 옛 파일이 해시 이름으로 남는다 → 매니페스트에 없는 조각은 정리한다.
    keys = set(manifest['phrases'].values())
    removed = 0
    for v in manifest['voices']:
        d = os.path.join(OUT_DIR, v)
        for f in os.listdir(d):
            if f.endswith('.mp3') and f[:-4] not in keys:
                os.remove(os.path.join(d, f))
                removed += 1
    if removed:
        print(f'  (안 쓰는 옛 조각 {removed}개 삭제)')

    total = sum(
        os.path.getsize(os.path.join(OUT_DIR, v, f))
        for v in manifest['voices'] for f in os.listdir(os.path.join(OUT_DIR, v))
    )
    print(f'\n완료 — 조각 {len(phrases)}개 × 목소리 {len(manifest["voices"])}종 · 총 {total/1024:.0f}KB')
    print(f'manifest: client/public/voice/manifest.json')
    if BAD:
        print('')
        print('경고 — 받지 못한 조각 (다시 실행하면 이 파일만 다시 받는다):')
        for b in BAD:
            print('   ' + b)
        sys.exit(1)


asyncio.run(main())
