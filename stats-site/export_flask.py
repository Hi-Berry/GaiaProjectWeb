# -*- coding: utf-8 -*-
"""score_input Flask 앱(ELO/개인별/종족별 통계)을 정적 HTML로 스냅샷해 dist/에 저장.

- Flask test_client로 읽기 전용 페이지를 크롤링(BFS) → 내부 링크를 평탄화 파일명으로 재작성.
- JS가 런타임에 만드는 링크('/player/'+name 등)는 클릭 시 같은 규칙으로 변환하는 shim 주입.
- 쓰기 라우트(/submit, /delete-game, /admin/*)와 점수 입력 페이지(/)는 제외 — '/' 링크는 통계 홈으로.
사용: python export_flask.py  (stats-site/build.mjs가 자동 호출)
"""
import os
import re
import sys
import io

APP_DIR = r"C:\Users\ColinJang\AI Project\score_input"
DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, APP_DIR)
os.chdir(APP_DIR)  # app.py의 상대경로 데이터(Data/result.txt) 로드용

from app import app  # noqa: E402

ALLOWED = re.compile(r"^/(player-statistics|race-statistics|hall-of-fame|game-records|player/|race/)")
# JS 문자열 조각(' + name + ' / ${...})이 href 정규식에 걸려 URL로 오인되는 것 차단 — 실제 URL 문자만 허용
CLEAN_URL = re.compile(r"^/[A-Za-z0-9\-_/?=&%.가-힣]+$")


def flatten(url: str) -> str:
    """내부 URL → 정적 파일명. shim(JS)과 동일 규칙 유지할 것."""
    if url in ("", "/"):
        return "index.html"  # 점수 입력 페이지 대신 통계 홈으로
    path, _, query = url.partition("?")
    name = path.strip("/").replace("/", "_")
    m = re.search(r"month=([^&]*)", query)
    if m:
        name += "_m" + m.group(1)
    return name + ".html"


SHIM = """
<script>
// 정적 스냅샷 링크 shim — JS가 런타임에 만드는 절대경로 링크를 평탄화 파일명으로 변환
(function () {
  function flatten(url) {
    if (url === '/' || url === '') return 'index.html';
    var q = url.split('?'); var path = q[0]; var query = q[1] || '';
    var name = path.replace(/^\\/+|\\/+$/g, '').replace(/\\//g, '_');
    var m = query.match(/month=([^&]*)/);
    if (m) name += '_m' + m[1];
    return name + '.html';
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    var h = a.getAttribute('href');
    if (h && h.charAt(0) === '/' && h.indexOf('//') !== 0) a.setAttribute('href', flatten(h));
  }, true);
})();
</script>
"""


def rewrite_links(html: str) -> str:
    def repl(m):
        return 'href="' + flatten(m.group(1)) + '"'
    html = re.sub(r'href="(/[^"]*)"', repl, html)
    # shim 주입 (</body> 앞)
    if "</body>" in html:
        html = html.replace("</body>", SHIM + "</body>", 1)
    else:
        html += SHIM
    return html


def main():
    os.makedirs(DIST, exist_ok=True)
    client = app.test_client()
    seeds = ["/player-statistics", "/race-statistics", "/hall-of-fame", "/game-records"]
    queue = list(seeds)
    done = set()
    saved = 0
    while queue:
        url = queue.pop(0)
        if url in done:
            continue
        done.add(url)
        try:
            resp = client.get(url)
        except Exception as e:  # noqa: BLE001
            print(f"  ! {url} 요청 실패: {e}")
            continue
        if resp.status_code != 200:
            print(f"  ! {url} → HTTP {resp.status_code} (건너뜀)")
            continue
        html = resp.get_data(as_text=True)
        # 다음 크롤 대상 수집 (재작성 전 원본 링크 기준)
        for href in re.findall(r'href="(/[^"]*)"', html):
            if ALLOWED.match(href) and CLEAN_URL.match(href) and href not in done:
                queue.append(href)
        out = os.path.join(DIST, flatten(url))
        with open(out, "w", encoding="utf-8") as f:
            f.write(rewrite_links(html))
        saved += 1
    print(f"score_input 스냅샷 완료: {saved}페이지 → {DIST}")


if __name__ == "__main__":
    main()
