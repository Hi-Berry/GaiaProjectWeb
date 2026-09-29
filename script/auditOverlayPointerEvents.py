#!/usr/bin/env python3
"""[2026-09-25] 오버레이 클릭 차단 구멍 점검.

Radix Dialog/AlertDialog는 열려 있는 동안 document.body에 인라인 `pointer-events: none`을 건다(모달 밖 클릭 차단).
직접 만든 fixed 오버레이는 그 상속을 그대로 받으므로, Radix 콘텐츠(z-201)보다 위에 뜨도록 만든 오버레이는
`pointer-events-auto`를 명시하지 않으면 "화면엔 보이는데 버튼이 안 눌리는" 상태가 된다.
실제 제보 3건(접속 안내 게이트·롤백 투표·파워 제안)이 전부 이 원인이었다.

규칙: z > 201(Radix 콘텐츠)인데 상호작용 요소가 있고 pointer-events-auto가 없으면 구멍.
      z <= 201은 Radix가 위에 덮으므로 안 눌리는 것이 정상.
사용: python3 script/auditOverlayPointerEvents.py   (구멍이 있으면 종료코드 1)
"""
import re, glob, sys

RADIX_CONTENT_Z = 201
holes = []
rows = []
for f in glob.glob('client/src/**/*.tsx', recursive=True):
    if '/components/ui/' in f:
        continue  # Radix 래퍼 자신은 제외
    lines = open(f).read().split('\n')
    for i, line in enumerate(lines, 1):
        if 'fixed' not in line:
            continue
        m = re.search(r'z-\[(\d+)\]', line)
        if not m:
            continue
        z = int(m.group(1))
        if z <= RADIX_CONTENT_Z:
            continue
        chunk = '\n'.join(lines[i - 1:i + 3])
        body = '\n'.join(lines[i - 1:i + 40])
        pe = 'auto' if 'pointer-events-auto' in chunk else ('none' if 'pointer-events-none' in chunk else '(미지정)')
        interactive = bool(re.search(r'<Button|<button|<input|onClick=', body))
        rows.append((f.replace('client/src/', ''), i, z, pe, interactive))
        if interactive and pe != 'auto':
            holes.append((f.replace('client/src/', ''), i, z))

rows.sort(key=lambda r: -r[2])
print(f"{'파일:줄':36s}{'z':>5s}  {'pointer-events':14s}{'상호작용':>8s}")
for f, i, z, pe, it in rows:
    print(f"{f + ':' + str(i):36s}{z:5d}  {pe:14s}{'예' if it else '아니오':>8s}")
print()
if holes:
    print('★ 구멍 (Radix 위에 뜨는데 클릭을 못 받음):')
    for f, i, z in holes:
        print(f'  {f}:{i} (z={z})')
    sys.exit(1)
print('구멍 없음 — z>201 상호작용 오버레이는 모두 pointer-events-auto 명시됨.')
