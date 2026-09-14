/* 게임 기록 브라우저 — 브라우저 쪽 스크립트 (reports/games.mjs 가 페이지에 인라인). 의존성 없음.
   상태는 URL 해시로: #g=<gameId>  /  #g=<gameId>&p=<플레이어 인덱스>  (없으면 목록) */
(function () {
  'use strict';
  const D = window.__GAIA;
  const app = document.getElementById('app');
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const ko = (f) => D.ko[f] ?? f ?? '?';
  const col = (f) => D.color[f] ?? '#556';
  const face = (f, cls) => (D.faces[f] ? `<img class="${cls}" src="${D.faces[f]}" alt="" />` : `<span class="fdot" style="--fc:${col(f)}"></span>`);
  const byId = Object.fromEntries(D.index.map((g) => [g.id, g]));
  const hm = (t) => (t ? new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '?');

  // ── 조각 로더 (JSONP) ─────────────────────────────────────────────
  const chunkData = {}; const chunkWait = {};
  window.__gaiaChunk = (i, data) => { chunkData[i] = data; (chunkWait[i] ?? []).forEach((r) => r(data)); delete chunkWait[i]; };
  function loadChunk(i) {
    if (chunkData[i]) return Promise.resolve(chunkData[i]);
    return new Promise((resolve, reject) => {
      if (chunkWait[i]) { chunkWait[i].push(resolve); return; }
      chunkWait[i] = [resolve];
      const s = document.createElement('script');
      s.src = `games-data/c${String(i).padStart(2, '0')}.js`;
      s.onerror = () => { delete chunkWait[i]; reject(new Error('chunk ' + i)); };
      document.head.appendChild(s);
    });
  }
  const getGame = (id) => loadChunk(byId[id].c).then((c) => c[id]);

  // ── 라우팅 ─────────────────────────────────────────────────────────
  function route() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ''));
    return { g: h.get('g'), p: h.get('p') != null ? Number(h.get('p')) : null };
  }
  const go = (g, p) => { location.hash = g ? (p != null ? `g=${g}&p=${p}` : `g=${g}`) : ''; };
  window.addEventListener('hashchange', render);
  window.addEventListener('DOMContentLoaded', render);
  if (document.readyState !== 'loading') render();

  function render() {
    const r = route();
    if (!r.g || !byId[r.g]) { app.className = 'wrap'; renderList(); window.scrollTo(0, 0); return; }
    app.className = 'wrap wide';
    app.innerHTML = crumbs(r) + '<div class="loading">게임 상세 불러오는 중…</div>';
    getGame(r.g).then((game) => {
      if (route().g !== r.g) return;
      if (r.p != null && game.ps[r.p]) renderPlayer(game, r.p); else renderGame(game);
      window.scrollTo(0, 0);
    }).catch(() => { app.innerHTML = crumbs(r) + '<div class="empty">상세 데이터 조각을 불러오지 못했습니다. 페이지를 새로 고쳐 보세요.</div>'; });
  }
  function crumbs(r) {
    const g = r.g ? byId[r.g] : null;
    const parts = [`<button type="button" data-go="">🗂️ 게임 기록실</button>`];
    if (g) parts.push(`<span class="sep">›</span>`, r.p != null ? `<button type="button" data-go="${g.id}">${g.d} 게임</button>` : `<span class="cur">${g.d} 게임</span>`);
    if (g && r.p != null) parts.push(`<span class="sep">›</span>`, `<span class="cur" id="crumb-p"></span>`);
    return `<nav class="crumbs">${parts.join('')}</nav>`;
  }
  app.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]'); if (!b) return;
    const [g, p] = b.dataset.go.split('/');
    go(g || null, p != null && p !== '' ? Number(p) : null);
  });

  // ── 1. 목록 ────────────────────────────────────────────────────────
  const filt = { q: '', std: true, fac: '' };
  try { const v = localStorage.getItem('gaia-games-std'); if (v != null) filt.std = v === '1'; } catch { /* noop */ }
  function renderList() {
    const facs = [...new Set(D.index.flatMap((g) => g.ps.map((p) => p.f)))].sort((a, b) => ko(a).localeCompare(ko(b), 'ko'));
    app.innerHTML = `
      <h1>🗂️ <span class="green">가이아</span> 게임 기록실</h1>
      <p class="sub">저장된 사람 게임 로그 <b>${D.index.length}판</b>. 판을 누르면 네 사람의 결과가, 사람을 누르면 그 사람의 액션 하나하나와 점수 검증이 나옵니다.
        기본은 <b>사람 4인 · 6라운드 완료</b> 판만 보이고, 체크를 끄면 봇 게임과 미완 게임도 보입니다.</p>
      <div class="stamp">🕐 ${esc(D.stamp)} 시점 자료 기준</div>
      <div class="bar">
        <input type="search" id="q" placeholder="이름 · 종족 · 날짜(2026-08) 검색" value="${esc(filt.q)}" autocomplete="off" />
        <select id="fac"><option value="">모든 종족</option>${facs.map((f) => `<option value="${f}"${filt.fac === f ? ' selected' : ''}>${esc(ko(f))}</option>`).join('')}</select>
        <label class="chk"><input type="checkbox" id="std"${filt.std ? ' checked' : ''} /> 사람 4인 · 완료 판만</label>
        <span class="count" id="cnt"></span>
      </div>
      <div class="tblwrap"><table class="glist"><thead><tr><th>날짜</th><th>참가자 (순위순 · 금테 = 1위)</th><th>라운드</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
      <p class="legend">이름은 계정 통합(같은 사람의 다른 아이디)을 적용한 표준 이름입니다. 점선 칩은 봇. 종족 검색은 한글 이름(하드쉬·아이타…)으로.</p>
      <p class="foot">데이터: data/human-games 저장 로그 · 상세는 클릭할 때 조각 파일로 불러옵니다 (${D.chunkCount}조각).</p>`;
    const q = document.getElementById('q'), fac = document.getElementById('fac'), std = document.getElementById('std');
    q.addEventListener('input', () => { filt.q = q.value; drawRows(); });
    fac.addEventListener('change', () => { filt.fac = fac.value; drawRows(); });
    std.addEventListener('change', () => { filt.std = std.checked; try { localStorage.setItem('gaia-games-std', std.checked ? '1' : '0'); } catch { /* noop */ } drawRows(); });
    drawRows();
  }
  function drawRows() {
    const q = filt.q.trim().toLowerCase();
    const terms = q ? q.split(/\s+/) : [];
    const hit = (g) => terms.every((t) => g.d.includes(t) || g.ps.some((p) => p.n.toLowerCase().includes(t) || ko(p.f).includes(t) || p.f.includes(t)));
    const list = D.index.filter((g) => (!filt.std || g.std) && (!filt.fac || g.ps.some((p) => p.f === filt.fac)) && hit(g));
    document.getElementById('cnt').textContent = `${list.length} / ${D.index.length}판`;
    const tb = document.getElementById('rows');
    if (!list.length) { tb.innerHTML = `<tr><td colspan="4" class="empty">조건에 맞는 판이 없습니다.</td></tr>`; return; }
    tb.innerHTML = list.map((g) => `<tr data-go="${g.id}" tabindex="0">
      <td class="d"><b>${g.d}</b></td>
      <td><div class="chips">${g.ps.map((p) => {
        const hl = terms.length && terms.some((t) => p.n.toLowerCase().includes(t) || ko(p.f).includes(t)) || (filt.fac && p.f === filt.fac);
        return `<span class="chip${p.rk === 1 ? ' win' : ''}${p.bot ? ' bot' : ''}${hl ? ' hl' : ''}" style="--fc:${col(p.f)}">${face(p.f, '')}<span class="nm">${esc(p.n)}</span><span class="fc">${esc(ko(p.f))}</span><span class="sc">${p.s}</span></span>`;
      }).join('')}</div></td>
      <td class="tag">R${g.r}${g.r < 6 ? '<span class="pill warn">미완</span>' : ''}</td>
      <td class="tag">${g.n !== 4 ? `<span class="pill">${g.n}인</span>` : ''}${g.bots ? `<span class="pill warn">봇 ${g.bots}</span>` : ''}</td>
    </tr>`).join('');
    tb.querySelectorAll('tr[tabindex]').forEach((tr) => tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') tr.click(); }));
  }

  // ── 2. 게임 ────────────────────────────────────────────────────────
  const BD_KO = { techTiles: '기술 타일', spaceships: '우주선', bonusTilePass: '패스 보너스 타일', roundMissions: '라운드 임무', finalMissions: '최종 임무', powerReceived: '파워 리치로 잃은 VP', researchTracks: '연구 트랙', remainingResources: '잔여 자원', 'other · 연방 보상 VP': '연방 보상', 'other · 종족 비딩': '종족 비딩', 'other · 우주선 입장': '우주선 입장' };
  const bdKo = (k) => BD_KO[k] ?? k.replace(/^other · /, '');
  function renderGame(game) {
    const idx = byId[game.id];
    const ranked = game.ps.map((p, i) => ({ p, i })).sort((a, b) => a.p.rk - b.p.rk);
    const maxBd = Math.max(1, ...game.ps.flatMap((p) => Object.values(p.bd).map(Math.abs)));
    const cards = ranked.map(({ p, i }) => {
      const bd = Object.entries(p.bd).sort((a, b) => b[1] - a[1]).filter(([, v]) => v !== 0);
      return `<button type="button" class="pcard" data-go="${game.id}/${i}" style="--fc:${col(p.f)}" title="${esc(p.n)} 액션 감사 보기">
        <div class="top"><span class="medal r${Math.min(p.rk, 4)}">${p.rk}</span>${face(p.f, 'face')}
          <div class="who"><div class="nm">${esc(p.n)}${p.bot ? ' <span class="pill">봇</span>' : ''}</div><div class="fc">${esc(ko(p.f))} · ${p.order}번째 시작</div></div>
          <div class="score">${p.s}<small>점</small></div></div>
        <div class="bd">${bd.map(([k, v]) => `<div class="bdr"><span class="lbl">${esc(bdKo(k))}</span><span class="val${v < 0 ? ' neg' : ''}">${v > 0 ? '+' : ''}${v}</span><span class="barbg"><i style="width:${Math.round(100 * Math.abs(v) / maxBd)}%"></i></span></div>`).join('')}</div>
        <div class="kv"><span>연구</span><b>${esc(p.research) || '–'}</b><span>연방</span><b>${p.feds}</b><span>보너스</span><b>${esc(p.bonus) || '–'}</b><span>타일 ${p.tiles.length}</span><span class="tiles">${p.tiles.map(esc).join(' · ') || '–'}</span></div>
      </button>`;
    }).join('');
    const boardRows = game.board.map(([r, vps, res]) => {
      const lead = Math.max(...vps.filter((v) => v != null));
      return `<tr><td>${r === 0 ? '준비' : 'R' + r}</td>${ranked.map(({ i }) => `<td${vps[i] === lead ? ' class="lead"' : ''}>${vps[i] ?? '–'}<span class="res">${esc(res[i])}</span></td>`).join('')}</tr>`;
    }).join('');
    app.innerHTML = crumbs({ g: game.id }) + `
      <div class="ghead"><h1>${idx.d} <span class="green">${game.ps.length}인 게임</span></h1>
        <div class="meta">${hm(game.start)} → ${hm(game.end)} · 실플레이 ${game.play}분${game.breaks ? ` (10분↑ 휴식 ${game.breaks}회 제외)` : ''} · 라운드 ${game.rounds} · 로그 ${game.tl.length}건 · <span title="게임 ID">${esc(game.id)}</span></div></div>
      <div class="pcards">${cards}</div>
      <section class="sec"><h2>라운드 끝 점수판 <span class="hint">각 라운드 마지막 액션 직후 VP · 자원</span></h2>
        <div class="tblwrap"><table class="board"><thead><tr><th></th>${ranked.map(({ p }) => `<th>${esc(p.n)} <span style="color:${col(p.f)}">${esc(ko(p.f))}</span></th>`).join('')}</tr></thead><tbody>${boardRows}</tbody></table></div></section>
      <section class="sec"><h2>전체 타임라인 <span class="hint">모든 사람의 액션을 순서대로</span></h2>${timeline(game, null)}</section>
      <p class="foot">카드를 누르면 그 사람의 액션별 자원 흐름과 점수 검증(감사)으로 들어갑니다.</p>`;
  }
  function timeline(game, meIdx) {
    let cur = null; const out = [];
    for (const [seq, r, pi, act, det, dif] of game.tl) {
      if (r !== cur) { cur = r; out.push(`<div class="rh">${r === 0 ? '준비 단계' : '라운드 ' + r}</div>`); }
      const p = pi >= 0 ? game.ps[pi] : null;
      out.push(`<div class="ev${meIdx != null && pi === meIdx ? ' hl' : ''}" style="--fc:${p ? col(p.f) : ''}"><span class="seq">${seq}</span><span class="who${p ? '' : ' sys'}">${p ? esc(p.n) : '시스템'}</span><span class="act">${esc(act)}</span><span class="det">${esc(det)}</span><span class="dif">${esc(dif)}</span></div>`);
    }
    return `<div class="tl${meIdx != null ? ' onlyme' : ''}" id="tl">${out.join('')}</div>`;
  }

  // ── 3. 사람 (감사) ───────────────────────────────────────────────────
  const GK = ['C', 'O', 'K', 'Q', 'P1', 'P2', 'P3'];
  const cell = (val, delta, cls) => {
    const d = delta ?? 0;
    const em = d ? `<em class="${d > 0 ? 'up' : 'dn'}">(${d > 0 ? '+' : ''}${d})</em>` : '';
    return `<td class="colsep ${cls ?? ''}"><span class="cur${d ? '' : ' dim'}">${val ?? ''}</span>${em}</td>`;
  };
  function renderPlayer(game, pi) {
    const idx = byId[game.id]; const me = game.ps[pi]; const A = me.audit;
    const ranked = game.ps.map((p, i) => ({ p, i })).sort((a, b) => a.p.rk - b.p.rk);
    const okMark = (c) => (c === true ? '<span class="ok">✔</span>' : c === false ? '<span class="bad">✘</span>' : '<span class="na">–</span>');
    let lastR = null; let lastTiles = [];
    const rows = A.rows.map((row) => {
      const [r, action, details, flag, vp, dvp, cur, dres] = row;
      const rstart = r !== lastR && flag !== 2; if (flag !== 2) lastR = r;
      if (flag === 2) {
        return `<tr class="imp"><td></td><td class="l">〈액션 외 변동${details ? ' · 위 ·표시 자동 액션 포함' : ''}〉 <span class="sub">leech 수락·수익·의회 등</span></td>${cell(vp, dvp, 'vpcol')}${GK.map((k, i) => cell(cur[i], dres[i])).join('')}<td class="colsep state"></td><td class="state"></td><td class="colsep state"></td></tr>`;
      }
      const [, , , , , , , , b, research, tilesRaw, bChg, ups, tAdded] = row;
      const tiles = Array.isArray(tilesRaw) ? (lastTiles = tilesRaw) : lastTiles;
      return `<tr class="${flag === 1 ? 'nolog' : ''}${rstart ? ' rstart' : ''}"><td class="rnd">R${r}</td>
        <td class="l"><b>${esc(action)}</b>${details ? ` <span class="sub">${esc(details)}</span>` : ''}</td>
        ${cell(vp, dvp, 'vpcol')}${GK.map((k, i) => cell(cur[i], dres[i])).join('')}
        <td class="colsep state${bChg ? ' chg' : ''}">${esc(b)}</td><td class="state${ups ? ' chg' : ''}">${esc(research)}</td>
        <td class="colsep state tiles${tAdded ? ' chg' : ''}">${tiles.map(esc).join(' · ')}</td></tr>`;
    }).join('');
    const bdRows = Object.entries(A.groups).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td class="l">${esc(bdKo(k))} <span class="sub">${esc(k)}</span></td><td class="${v < 0 ? 'dn' : ''}">${v > 0 ? '+' : ''}${v}</td></tr>`).join('');
    app.innerHTML = crumbs({ g: game.id, p: pi }) + `
      <div class="ptabs">${ranked.map(({ p, i }) => `<button type="button" data-go="${game.id}/${i}" class="${i === pi ? 'on' : ''}" style="--fc:${col(p.f)}">${face(p.f, '')}<span class="nm">${esc(p.n)}</span><span class="sc">${esc(ko(p.f))} ${p.s}</span></button>`).join('')}</div>
      <h1>🔍 ${esc(me.n)} <span class="green">${esc(ko(me.f))} ${me.s}점</span> 감사</h1>
      <p class="sub">${idx.d} · ${game.ps.length}인 중 ${me.rk}위 · ${me.order}번째 시작 · 액션 ${A.actions}개 · gameLog 대조 ${A.matched}개</p>
      <div class="cards" style="margin-top:16px">${A.cards.map((c) => `<div class="card${c.ok === false ? ' isbad' : ''}">${okMark(c.ok)} ${c.html}</div>`).join('')}</div>
      <div class="tblwrap"><table class="audit"><thead><tr>
        <th>R</th><th class="l">액션</th><th class="colsep vpcol">VP</th>${GK.map((k) => `<th class="colsep">${k}</th>`).join('')}<th class="colsep l">건물</th><th class="l">연구</th><th class="colsep l">기술 타일 (보유 순)</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      <div class="bdt tblwrap"><table class="audit"><thead><tr><th class="l">점수 내역 (scoreBreakdown)</th><th>VP</th></tr></thead><tbody>${bdRows}
        <tr><td class="l"><b>합계 (파워수령 차감 반영)</b></td><td><b>${A.total}</b> (+시작 ${A.startVp} = ${A.startVp + A.total})</td></tr></tbody></table></div>
      <section class="sec"><h2>이 사람의 타임라인 <span class="hint">다른 사람 액션은 접음</span> <label class="toggle"><input type="checkbox" id="showall" /> 모두 보기</label></h2>${timeline(game, pi)}</section>
      <p class="legend">읽는 법: 각 행 = ${esc(me.n)}의 액션 하나. 자원 칸은 <b>액션 후 보유량(±이번 액션 변동)</b> — 예: <b>4</b><em class="dn">(-3)</em>는 3을 쓰고 4가 남았다는 뜻. 변동 없는 칸은 흐리게.
        회색 〈액션 외 변동〉 행은 내 액션 사이에 생긴 변화(다른 사람 턴의 파워 leech 수락, 수익 단계 세부 등) — 직전 액션의 '후 보유'와 다음 액션의 '전 보유'의 차이를 그대로 보여주므로, 여기 이상한 값이 있으면 버그 후보입니다.
        액션명 뒤 ' ·'는 gameLog에 대응 항목이 없어 직전 액션 후 상태를 기준으로 변동을 계산한 행(종족 자동 변환 등). 건물 열은 액션 이름으로 재구성한 M(광산)·T(교역소)·L(연구소)·P(행성연구소)·A(아카데미) 수, 노란색은 그 액션으로 바뀐 칸.</p>`;
    const crumbP = document.getElementById('crumb-p'); if (crumbP) crumbP.textContent = `${me.n} (${ko(me.f)})`;
    document.getElementById('showall').addEventListener('change', (e) => { document.getElementById('tl').classList.toggle('onlyme', !e.target.checked); });
  }
})();
