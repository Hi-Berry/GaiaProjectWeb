#!/usr/bin/env python3
"""사람 결정 데이터셋 빌더 — data/human-games/*.json → 상태×후보 피처 + 라벨(사람이 고른 후보 index).

각 게임의 fullGameLog를 시간순으로 리플레이해 결정 시점의 보드(타일 주인/건물, 우주선 탑승, 라운드 내 사용 슬롯)를
복원하고, actionJournal의 사람 결정(candidates 포함)을 timestamp로 정렬해 붙인다. 피처는 실서버 상태에서 그대로
계산 가능한 것만 쓴다(통합 시 bot.ts로 이식). 출력: <out>/decisions.npz (+ meta.json).

  python3 build_dataset.py --out data/humanPolicy [--since 2026-06] [--players 4]
"""
import json, glob, os, sys, argparse, re
import numpy as np

TYPES = ['build_mine', 'upgrade_structure', 'advance_research', 'use_power_action', 'use_ship_action', 'enter_spaceship',
         'place_gaiaformer', 'use_tech_action', 'use_bonus_action', 'use_special_action', 'form_federation',
         'take_twilight_artifact', 'convert_resource', 'pass_round', 'place_ivits_space_station']
TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science']
SHIPS = ['ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse']
TARGETS = ['trading_station', 'research_lab', 'academy', 'planetary_institute']
PLANETS = ['terra', 'desert', 'swamp', 'oxide', 'volcanic', 'titanium', 'ice', 'gaia', 'transdim', 'proto', 'asteroid', 'other']
PW_ACTIONS = ['gain-3-knowledge', 'gain-2-steps', 'gain-2-ore', 'gain-7-credits', 'gain-2-knowledge', 'gain-1-step', 'gain-2-tokens']
BONUS = ['bon-2c-terraform', 'bon-2c-1q', 'bon-1o-2tokens', 'bon-4c-gaia', 'bon-1o-mine', 'bon-1o-ts', 'bon-1k-lab',
         'bon-4pw-bigbuilding', 'bon-1o-planettype', 'bon-2pw-range3', 'bon-2pw-gaiaproject', 'bon-3c-bridge']
FACTIONS = ['terran', 'lantids', 'xenos', 'gleens', 'taklons', 'ambas', 'hadsch_hallas', 'ivits', 'geodens', 'bal_tak',
            'firaks', 'bescods', 'nevlas', 'itars', 'darkanians', 'moweyip', 'tinkeroids', 'space_giants', 'other']
NONPLANET = {'space', 'deep_space', 'lost_fleet_ship'}
STRUCT = ['mine', 'trading_station', 'research_lab', 'planetary_institute', 'academy']
SHIP_LBL = [
    ('Rebellion: Gain tech tile', 'ship_rebellion', 1), ('Rebellion: Mine', 'ship_rebellion', 2), ('Rebellion: 2K', 'ship_rebellion', 3),
    ('Twilight: Federation benefit', 'ship_twilight', 1), ('Twilight: Spaceship Fed', 'ship_twilight', 1), ('Twilight: TS', 'ship_twilight', 2), ('Twilight: +3 Range', 'ship_twilight', 3),
    ('TF Mars: Tech tiles', 'ship_tf_mars', 1), ('TF Mars: Gaia Project', 'ship_tf_mars', 2), ('TF Mars: 3C', 'ship_tf_mars', 3),
    ('Eclipse: Planet types', 'ship_eclipse', 1), ('Eclipse: 2K+3P', 'ship_eclipse', 2), ('Eclipse: 6C', 'ship_eclipse', 3),
]
# 기술타일 종류(선택 라벨용은 아니고 보유 피처용)
TECH_KINDS = ['tech-inc-1o-1p', 'tech-inc-4c', 'tech-inc-1k-1c', 'tech-imm-7vp', 'tech-imm-1k-planet', 'tech-imm-1o-1q', 'tech-gaia-3vp', 'tech-big-4str', 'tech-act-4p']


def hdist(a, b):
    return (abs(a['q'] - b['q']) + abs(a['q'] + a['r'] - b['q'] - b['r']) + abs(a['r'] - b['r'])) / 2


def pw_cat(s):
    s = (s or '').lower()
    if 'ore' in s: return 0
    if 'credit' in s: return 1
    if 'know' in s: return 2
    if 'token' in s: return 3
    if re.search(r'terraform|step|tf', s): return 4
    return 5


def match_taken(e, cands, geom):
    a = e.get('action') or ''; d = (e.get('details') or '').lower(); tid = e.get('tileId')
    def fi(pred):
        for i, c in enumerate(cands):
            if pred(c): return i
        return -1
    if a in ('Built Mine', 'Built Mine on Asteroid', 'Built Mine on Proto'):
        return fi(lambda c: c.get('type') == 'build_mine' and c.get('tileId') == tid)
    if a.startswith('Upgraded to Trading Station'):
        return fi(lambda c: c.get('type') == 'upgrade_structure' and c.get('target') == 'trading_station' and c.get('tileId') == tid)
    if a.startswith('Upgraded to Research Lab'):
        return fi(lambda c: c.get('type') == 'upgrade_structure' and c.get('target') == 'research_lab' and c.get('tileId') == tid)
    if a.startswith('Upgraded to Planetary'):
        return fi(lambda c: c.get('type') == 'upgrade_structure' and c.get('target') == 'planetary_institute' and c.get('tileId') == tid)
    if a.startswith('Upgraded to Academy'):
        return fi(lambda c: c.get('type') == 'upgrade_structure' and str(c.get('target') or '').startswith('academy') and c.get('tileId') == tid)
    if a == 'Advanced Research':
        dd = d.replace(' ', '')
        return fi(lambda c: c.get('type') == 'advance_research' and str(c.get('trackId') or '').lower() in dd)
    if a == 'Power Action':
        return fi(lambda c: c.get('type') == 'use_power_action' and pw_cat(c.get('actionId')) == pw_cat(d))
    if a == 'Entered Ship':
        return fi(lambda c: c.get('type') == 'enter_spaceship' and (not tid or c.get('tileId') == tid))
    if a == 'Placed Gaiaformer':
        return fi(lambda c: c.get('type') == 'place_gaiaformer' and c.get('tileId') == tid)
    if a == 'Used Tech Action':
        return fi(lambda c: c.get('type') == 'use_tech_action' and (not tid or c.get('tileId') == tid))
    if a == 'Federation':
        return fi(lambda c: c.get('type') == 'form_federation')
    if a == 'Bonus Action':
        return fi(lambda c: c.get('type') == 'use_bonus_action')
    if a == 'Academy (Right)':
        return fi(lambda c: c.get('type') == 'use_special_action' and 'academy' in str(c.get('actionId') or ''))
    if a in ('Ivits: Space Station',):
        return fi(lambda c: c.get('type') == 'place_ivits_space_station' and (not tid or c.get('tileId') == tid))
    if a == 'Selected Bonus':
        return fi(lambda c: c.get('type') == 'pass_round')
    for p, ship, idx in SHIP_LBL:
        if a.startswith(p):
            return fi(lambda c: c.get('type') == 'use_ship_action' and c.get('actionIndex') == idx and (geom.get(c.get('shipTileId')) or {}).get('type') == ship)
    return -1


PW_COST = {'gain-3-knowledge': 7, 'gain-2-steps': 5, 'gain-2-ore': 4, 'gain-7-credits': 4, 'gain-2-knowledge': 4, 'gain-1-step': 3, 'gain-2-tokens': 3}


def power_action_id(details):
    """'Power Action' 로그 details('+2 Knowledge (2P)' 등) → 액션 id. 모르면 None."""
    m = re.match(r'\+(\d+)\s+(Knowledge|Terraform|Ore|Credits|Power tokens)', str(details or ''))
    if not m: return None
    n, what = int(m.group(1)), m.group(2)
    if what == 'Knowledge': return 'gain-3-knowledge' if n == 3 else 'gain-2-knowledge'
    if what == 'Terraform': return 'gain-2-steps' if n == 2 else 'gain-1-step'
    if what == 'Ore': return 'gain-2-ore'
    if what == 'Credits': return 'gain-7-credits'
    if what == 'Power tokens': return 'gain-2-tokens'
    return None


FEATURE_VERSION = 2


def onehot(lst, v):
    f = [0.0] * len(lst)
    if v in lst: f[lst.index(v)] = 1.0
    elif lst[-1] == 'other': f[-1] = 1.0
    return f


def state_features(e, ctx):
    p = e.get('playerBefore') or {}
    res = p.get('resources') or {}
    r = ctx['round']
    f = [r / 6.0]
    for k, n in (('credits', 20), ('ore', 10), ('knowledge', 10), ('qic', 5), ('power1', 8), ('power2', 8), ('power3', 8)):
        f.append(min(2.0, (res.get(k) or 0) / n))
    rs = p.get('research') or {}
    f += [(rs.get(t) or 0) / 5.0 for t in TRACKS]
    tiles = p.get('techTiles') or []
    f.append(len(tiles) / 9.0); f.append(sum(1 for t in tiles if str(t).startswith('adv-')) / 3.0)
    f += [1.0 if t in tiles else 0.0 for t in TECH_KINDS]
    feds = p.get('federations') or []
    f.append(len(feds) / 5.0)
    greens = sum(1 for x in feds if (isinstance(x, dict) and x.get('isGreen')) or (isinstance(x, str) and 'fed' in x))
    f.append(min(2, greens) / 2.0)
    f += onehot(BONUS, p.get('bonusTile'))
    f += onehot(FACTIONS, e.get('faction') or p.get('faction'))
    my = ctx['my']
    counts = {s: 0 for s in STRUCT}
    for t in my.values():
        if t.get('structure') in counts: counts[t['structure']] += 1
    f += [counts['mine'] / 8, counts['trading_station'] / 4, counts['research_lab'] / 3, counts['planetary_institute'], counts['academy'] / 2]
    f.append(len(ctx['entered']) / 3.0)
    f.append(min(4, ctx['slots_used_this_round']) / 4.0)
    f.append(min(6, ctx['my_actions_this_round']) / 6.0)
    # ── v2 확장(리플레이 복원 가능 정보) — 순서 고정, humanPolicy.ts stateFeaturesV2와 1:1 ──
    f.append(min(3.0, (e.get('scoreBefore') or 0) / 100.0))
    f += [1.0 if a in ctx['power_used'] else 0.0 for a in PW_ACTIONS]
    f += [min(4, ctx['tech_taken'].get(k, 0)) / 4.0 for k in TECH_KINDS]
    f.append(min(7, ctx['adv_taken']) / 7.0)
    oc = {s_: 0 for s_ in STRUCT}
    for t in ctx['others']:
        if t.get('structure') in oc: oc[t['structure']] += 1
    f += [oc['mine'] / 24, oc['trading_station'] / 12, oc['research_lab'] / 9, oc['planetary_institute'] / 3, oc['academy'] / 6]
    f.append(min(15, ctx['others_feds']) / 15.0)
    f += [1.0 if b in ctx['others_boosters'] else 0.0 for b in BONUS]
    ov = ctx['others_vp']; mx = max(ov) if ov else 0
    f.append(min(3.0, mx / 100.0)); f.append(max(-2.0, min(2.0, ((e.get('scoreBefore') or 0) - mx) / 50.0)))
    orr = ctx['others_res']  # list of dict(o,c,k,q,p3)
    n = max(1, len(orr))
    for key, norm in (('o', 10), ('c', 20), ('k', 10), ('q', 5), ('p3', 8)):
        f.append(min(2.0, sum(x.get(key, 0) for x in orr) / n / norm))
    f.append(min(3, ctx['others_passed']) / 3.0)
    return f


STATE_DIM = None


def cand_features(c, e, ctx, geom):
    p = e.get('playerBefore') or {}; res = p.get('resources') or {}; rs = p.get('research') or {}
    f = onehot(TYPES, c.get('type'))
    tile = geom.get(c.get('tileId')) if c.get('tileId') else None
    my = list(ctx['my'].values())
    # 타일 기하
    if tile and my:
        ds = [hdist(m, tile) for m in my]
        d_own = min(ds)
        f += [1.0, min(d_own, 9) / 9.0, sum(1 for x in ds if x == 1) / 6.0, sum(1 for x in ds if x <= 2) / 8.0]
    else:
        f += [0.0, 0.0, 0.0, 0.0]
    ttype = (tile or {}).get('type')
    f += onehot(PLANETS, ttype if (ttype and ttype not in NONPLANET and not str(ttype).startswith('ship_')) else 'other')
    # 타일에 적 인접(리치 기대) — 리플레이된 타 플레이어 건물 기준
    if tile:
        f.append(min(4, sum(1 for t in ctx['others'] if hdist(t, tile) <= 2)) / 4.0)
        f.append(1.0 if tile.get('sector') not in ctx['my_sectors'] else 0.0)
    else:
        f += [0.0, 0.0]
    # 연구
    trk = c.get('trackId')
    f += onehot(TRACKS, trk)
    f.append(((rs.get(trk) or 0) / 5.0) if trk else 0.0)
    # 파워액션
    f += onehot(PW_ACTIONS, c.get('actionId')) if c.get('type') == 'use_power_action' else [0.0] * len(PW_ACTIONS)
    # 우주선
    stype = (geom.get(c.get('shipTileId')) or {}).get('type') if c.get('shipTileId') else None
    f += onehot(SHIPS, stype)
    f += [1.0 if (c.get('type') == 'use_ship_action' and c.get('actionIndex') == k) else 0.0 for k in (1, 2, 3)]
    if c.get('type') == 'enter_spaceship' and tile:
        f += onehot(SHIPS, tile.get('type'))
    else:
        f += [0.0] * len(SHIPS)
    # 업글 타깃
    f += [1.0 if (c.get('type') == 'upgrade_structure' and str(c.get('target') or '').startswith(t)) else 0.0 for t in TARGETS]
    # 그 타일의 현재 건물(업글 출발점)
    cur = (ctx['my'].get(c.get('tileId')) or {}).get('structure') if c.get('tileId') else None
    f += onehot(STRUCT + ['other'], cur or 'other')
    # 후보의 pre-action 유무(변환 동반)
    f.append(1.0 if c.get('preActions') else 0.0)
    # ── v2 확장 ──
    f.append(1.0 if (c.get('type') == 'build_mine' and ttype and ttype not in ctx['my_types']) else 0.0)  # 새 행성 유형
    f.append((PW_COST.get(c.get('actionId'), 0) / 7.0) if c.get('type') == 'use_power_action' else 0.0)
    return f


def replay_game(d):
    """fullGameLog를 리플레이하며 사람 결정마다 (state_feat, [cand_feat...], label, meta) yield."""
    bots = set(d.get('botPlayerIds') or [])
    geom = {t['id']: t for t in d.get('map', [])}
    # 리플레이 상태
    owner = {}      # tileId -> pid
    struct = {}     # tileId -> structure
    entered = {}    # pid -> set(shipTileId)
    slots_used = {} # round -> count of ship actions used (all players)
    actions_this_round = {}  # (pid, round) -> n main actions
    power_used = {}   # round -> set(actionId)
    tech_taken = {}   # kind -> n
    adv_taken = [0]
    booster_of = {}   # pid -> bonus id
    passed = {}       # round -> set(pid)
    feds_of = {}      # pid -> n
    last_snap = {}    # pid -> (vp, res dict) from gameLog snaps
    glog = sorted(d.get('gameLog') or [], key=lambda e: e.get('timestamp') or 0); gi = 0
    journal = [e for e in (d.get('actionJournal') or []) if e.get('playerId') not in bots and e.get('phase') == 'main' and e.get('candidates')]
    journal.sort(key=lambda e: e.get('timestamp') or 0)
    ji = 0
    log = sorted(d.get('fullGameLog') or [], key=lambda e: e.get('timestamp') or 0)
    n_decisions = 0
    for ev in log:
        ts = ev.get('timestamp') or 0
        # 이 로그 이벤트 이전 시각의 저널 결정들을 먼저 처리(결정 시점 상태 = 그 이벤트 반영 전)
        while ji < len(journal) and (journal[ji].get('timestamp') or 0) <= ts:
            e = journal[ji]; ji += 1
            pid = e.get('playerId'); r = e.get('round') or 0
            # gameLog 스냅을 결정 시점까지 반영(상대 VP/자원의 마지막 관측값)
            while gi < len(glog) and (glog[gi].get('timestamp') or 0) <= (e.get('timestamp') or 0):
                g = glog[gi]; gi += 1
                if g.get('playerId') and g.get('snap'): last_snap[g['playerId']] = g['snap']
            my = {tid: dict(geom[tid], structure=struct[tid]) for tid, o in owner.items() if o == pid and tid in geom}
            others = [dict(geom[tid], structure=struct[tid]) for tid, o in owner.items() if o != pid and tid in geom]
            opp_ids = [q for q in d['players'] if q != pid]
            ctx = {'round': r, 'my': my, 'others': others, 'my_sectors': {t.get('sector') for t in my.values()},
                   'entered': entered.get(pid, set()), 'slots_used_this_round': slots_used.get(r, 0),
                   'my_actions_this_round': actions_this_round.get((pid, r), 0),
                   'power_used': power_used.get(r, set()), 'tech_taken': tech_taken, 'adv_taken': adv_taken[0],
                   'others_feds': sum(feds_of.get(q, 0) for q in opp_ids),
                   'others_boosters': {booster_of.get(q) for q in opp_ids if booster_of.get(q)},
                   'others_vp': [last_snap[q].get('vp', 0) for q in opp_ids if q in last_snap],
                   'others_res': [last_snap[q] for q in opp_ids if q in last_snap],
                   'others_passed': len([q for q in passed.get(r, set()) if q != pid]),
                   'my_types': {t.get('type') for t in my.values()}}
            cands = e['candidates']
            label = match_taken(e, cands, geom)
            sf = state_features(e, ctx)
            cf = [cand_features(c, e, ctx, geom) for c in cands]
            n_decisions += 1
            # [2026-09-22] 결정자의 최종 점수·순위 — 라벨 품질 실험(고득점 좌석만/가중 학습)용. 순위는 같은 게임 players 점수 내림차순.
            scores = sorted((q.get('score') or 0 for q in d['players'].values()), reverse=True)
            myScore = (d['players'].get(pid) or {}).get('score') or 0
            yield sf, cf, label, {'game': d.get('gameId'), 'round': r, 'action': e.get('action'), 'n': len(cands), 'faction': e.get('faction'),
                                  'seat_vp': myScore, 'seat_rank': scores.index(myScore) + 1}
        # 로그 이벤트 반영
        pid = ev.get('playerId'); a = ev.get('action') or ''; tid = ev.get('tileId'); r = ev.get('round') or 0
        if a in ('Built Mine', 'Built Mine on Asteroid', 'Built Mine on Proto', 'Built Parasitic Mine') and tid:
            if a != 'Built Parasitic Mine': owner[tid] = pid; struct[tid] = 'mine'
        elif a.startswith('Upgraded to Trading Station') and tid: owner[tid] = pid; struct[tid] = 'trading_station'
        elif (a.startswith('Upgraded to Research Lab') or a == 'Twilight: TS → Research Lab') and tid: owner[tid] = pid; struct[tid] = 'research_lab'
        elif a.startswith('Upgraded to Planetary') and tid: owner[tid] = pid; struct[tid] = 'planetary_institute'
        elif a.startswith('Upgraded to Academy') and tid: owner[tid] = pid; struct[tid] = 'academy'
        elif a == 'Rebellion: Mine → TS' and tid: owner[tid] = pid; struct[tid] = 'trading_station'
        elif a == 'Entered Ship' and tid: entered.setdefault(pid, set()).add(tid)
        if a.startswith(('Twilight:', 'Rebellion:', 'Eclipse:', 'TF Mars:')) and 'Gained' not in a and 'Advanced track' not in a:
            slots_used[r] = slots_used.get(r, 0) + 1
        if a == 'Power Action':
            aid = power_action_id(ev.get('details'))
            if aid: power_used.setdefault(r, set()).add(aid)
        if a in ('Gained Tech Tile', 'Rebellion: Gained Tech Tile') and tid in TECH_KINDS: tech_taken[tid] = tech_taken.get(tid, 0) + 1
        if a == 'Advanced Tech Tile': adv_taken[0] += 1
        if a in ('Selected Bonus', 'Selected Bonus Tile'):
            m = re.search(r'took (bon-[\w-]+)', str(ev.get('details') or '')) or re.search(r'(bon-[\w-]+)', str(ev.get('details') or ''))
            if m: booster_of[pid] = m.group(1)
            elif tid and str(tid).startswith('bon-'): booster_of[pid] = tid
            if a == 'Selected Bonus': passed.setdefault(r, set()).add(pid)
        if a == 'Federation': feds_of[pid] = feds_of.get(pid, 0) + 1
        if a not in ('Received Power', 'Free Actions', 'Power Burn', 'Selected Bonus', 'Income Order', 'Undo Free Action', 'Gained Tech Tile', 'Federation Reward'):
            actions_this_round[(pid, r)] = actions_this_round.get((pid, r), 0) + 1
    return


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='data/humanPolicy'); ap.add_argument('--since', default='2026-06'); ap.add_argument('--players', type=int, default=0)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    files = sorted(f for f in glob.glob('data/human-games/*.json') if os.path.basename(f) >= args.since)
    S, C, L, M, G = [], [], [], [], []  # state feats, cand feats(list per decision), labels, meta, game index
    stats = {'games': 0, 'decisions': 0, 'labeled': 0, 'unlabeled_actions': {}}
    for gi, f in enumerate(files):
        try: d = json.load(open(f))
        except Exception: continue
        if d.get('roundNumber') != 6: continue  # 사람끼리 한 게임도 봇 후보 목록이 기록되므로 전부 사용
        if args.players and len(d.get('players', {})) != args.players: continue
        stats['games'] += 1
        for sf, cf, label, meta in replay_game(d):
            stats['decisions'] += 1
            if label < 0:
                stats['unlabeled_actions'][meta['action']] = stats['unlabeled_actions'].get(meta['action'], 0) + 1
                continue
            if len(cf) < 2: continue  # 후보 1개는 학습 신호 없음
            stats['labeled'] += 1
            S.append(sf); C.append(cf); L.append(label); M.append(meta); G.append(gi)
    # 가변 길이 후보 → 패딩(최대 40)
    MAXC = 40
    n = len(S); sd = len(S[0]); cd = len(C[0][0])
    X_s = np.zeros((n, sd), np.float32); X_c = np.zeros((n, MAXC, cd), np.float32); mask = np.zeros((n, MAXC), np.bool_); y = np.zeros(n, np.int64)
    for i in range(n):
        X_s[i] = S[i]; k = min(MAXC, len(C[i]))
        X_c[i, :k] = np.array(C[i][:k], np.float32); mask[i, :k] = True
        y[i] = L[i] if L[i] < MAXC else 0
    np.savez_compressed(os.path.join(args.out, 'decisions.npz'), X_s=X_s, X_c=X_c, mask=mask, y=y, game=np.array(G), round=np.array([m['round'] for m in M]), ncand=np.array([m['n'] for m in M]),
                        seat_vp=np.array([m.get('seat_vp', 0) for m in M]), seat_rank=np.array([m.get('seat_rank', 0) for m in M]))
    json.dump({'stats': stats, 'feature_version': FEATURE_VERSION, 'state_dim': sd, 'cand_dim': cd, 'maxc': MAXC, 'types': TYPES, 'tracks': TRACKS, 'ships': SHIPS, 'targets': TARGETS, 'planets': PLANETS, 'pw_actions': PW_ACTIONS, 'bonus': BONUS, 'factions': FACTIONS, 'tech_kinds': TECH_KINDS, 'struct': STRUCT}, open(os.path.join(args.out, 'meta.json'), 'w'), ensure_ascii=False, indent=1)
    top_unl = sorted(stats['unlabeled_actions'].items(), key=lambda kv: -kv[1])[:12]
    print(f"games {stats['games']} decisions {stats['decisions']} labeled {stats['labeled']} | state_dim {sd} cand_dim {cd}")
    print("unlabeled top:", top_unl)


if __name__ == '__main__':
    main()
