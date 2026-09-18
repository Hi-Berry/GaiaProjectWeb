#!/usr/bin/env python3
"""피처 이식 검증 픽스처 — 합성 결정 1개의 파이썬 피처(v1/v2)를 JSON으로 내보낸다. TS 테스트가 같은 상태를 만들어 대조.
  python3 make_fixture.py <out.json>
"""
import json, sys
import build_dataset as B
geom = {
  't1': {'id': 't1', 'q': 0, 'r': 0, 'type': 'terra', 'sector': 1}, 't2': {'id': 't2', 'q': 1, 'r': 0, 'type': 'desert', 'sector': 1},
  't3': {'id': 't3', 'q': 2, 'r': 0, 'type': 'gaia', 'sector': 2}, 't4': {'id': 't4', 'q': 0, 'r': 2, 'type': 'volcanic', 'sector': 3},
  't5': {'id': 't5', 'q': 3, 'r': 1, 'type': 'ice', 'sector': 2}, 't6': {'id': 't6', 'q': 4, 'r': 2, 'type': 'terra', 'sector': 4},
  'internal-0': {'id': 'internal-0', 'q': 5, 'r': 5, 'type': 'ship_twilight', 'sector': 9}, 's1': {'id': 's1', 'q': 1, 'r': 1, 'type': 'space', 'sector': 1},
}
pb = {'faction': 'terran', 'resources': {'credits': 12, 'ore': 3, 'knowledge': 5, 'qic': 1, 'power1': 2, 'power2': 3, 'power3': 4},
      'research': {'terraforming': 1, 'navigation': 2, 'artificialIntelligence': 0, 'gaiaProject': 1, 'economy': 0, 'science': 3},
      'techTiles': ['tech-inc-4c', 'adv-imm-2vp-mine'], 'federations': [{'rewardId': 'fed-8vp-1q', 'isGreen': True}, 'fed-12vp'], 'bonusTile': 'bon-1o-mine'}
e = {'playerBefore': pb, 'faction': 'terran', 'round': 3, 'scoreBefore': 37}
my = {'t1': dict(geom['t1'], structure='mine'), 't2': dict(geom['t2'], structure='trading_station')}
others = [dict(geom['t4'], structure='mine'), dict(geom['t6'], structure='research_lab')]
ctx = {'round': 3, 'my': my, 'others': others, 'my_sectors': {1}, 'entered': {'internal-0'}, 'slots_used_this_round': 2, 'my_actions_this_round': 1,
       'power_used': {'gain-2-ore', 'gain-7-credits'}, 'tech_taken': {'tech-inc-4c': 2, 'tech-act-4p': 1}, 'adv_taken': 3,
       'others_feds': 4, 'others_boosters': {'bon-2c-1q', 'bon-1k-lab'}, 'others_vp': [55, 41, 20],
       'others_res': [{'vp': 55, 'o': 2, 'c': 9, 'k': 3, 'q': 0, 'p3': 5}, {'vp': 41, 'o': 4, 'c': 3, 'k': 1, 'q': 2, 'p3': 1}, {'vp': 20, 'o': 1, 'c': 14, 'k': 0, 'q': 1, 'p3': 0}],
       'others_passed': 1, 'my_types': {'terra', 'desert'}}
cands = [{'type': 'build_mine', 'tileId': 't3'}, {'type': 'build_mine', 'tileId': 't5'}, {'type': 'upgrade_structure', 'tileId': 't2', 'target': 'research_lab'},
         {'type': 'advance_research', 'trackId': 'science'}, {'type': 'use_power_action', 'actionId': 'gain-2-knowledge'},
         {'type': 'use_ship_action', 'shipTileId': 'internal-0', 'actionIndex': 2}, {'type': 'enter_spaceship', 'tileId': 'internal-0'}, {'type': 'pass_round'}]
sf = B.state_features(e, ctx); cf = [B.cand_features(c, e, ctx, geom) for c in cands]
json.dump({'version': B.FEATURE_VERSION, 'geom': list(geom.values()), 'player': pb, 'scoreBefore': 37, 'my': my, 'others': others,
           'ctx': {k: (sorted(v) if isinstance(v, set) else v) for k, v in ctx.items() if k not in ('my', 'others')},
           'cands': cands, 'state': sf, 'cand': cf}, open(sys.argv[1], 'w'))
print('fixture', sys.argv[1], 'state', len(sf), 'cand', len(cf[0]))
