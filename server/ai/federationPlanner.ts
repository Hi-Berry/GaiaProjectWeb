import { ServerGameState } from '../gameState';
import {
    HexTile,
    PlayerState,
    getFederationEntries,
    getNeighbors,
    isEmptyHex,
    isPlanetHex,
    FEDERATION_REWARDS,
    getNextRoundIncomePreview
} from '@shared/gameConfig';
import {
    getFederationRequiredPower,
    getFederationBuildingPower,
    getPlanetConnectedComponent,
    getFederationPlanetIdsFromSelectedEmpties
} from '../gameState';
import { getPlayerFlag } from './variant';

export class FederationPlanner {
    /** extraTokens: 프리 액션으로 얻을 예정인 파워(위성) 수를 가정해 더 좋은 연방(예: 12VP) 탐색 */
    static getBestFederationAction(game: ServerGameState, playerId: string, extraTokens = 0): {
        selectedHexIds: string[],
        selectedPlanetIds: string[],
        rewardId: string,
        spentTokens: number
    } | null {
        const all = this.getFederationActions(game, playerId, extraTokens, 1);
        return all.length ? all[0] : null;
    }

    /**
     * 연방 후보 여러 개 반환 (상위 limit개).
     * - 봇이 "1개만 연방"에 고착되는 문제를 줄이기 위해, 좋은 대안 연방도 후보로 제공.
     */
    static getFederationActions(
        game: ServerGameState,
        playerId: string,
        extraTokens = 0,
        limit = 3
    ): { selectedHexIds: string[], selectedPlanetIds: string[], rewardId: string, spentTokens: number }[] {
        const player = game.players[playerId];
        if (!player) return [];

        const requiredPower = getFederationRequiredPower(game, playerId);
        const isIvits = player.faction === 'ivits';
        // 타클론 브레인 스톤도 위성 1개분 토큰으로 사용 가능(서버 spendPowerTokens와 일치) → 후보 산정에 포함.
        const brainTok = (player.faction === 'taklons' && player.brainStoneBowl != null && !player.brainStoneInGaia) ? 1 : 0;
        let availableTokens = isIvits ? (player.qic || 0) : ((player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0) + brainTok);
        availableTokens += extraTokens;

        const fedHexes = game.playerFederationHexes?.[playerId] || [];
        const myStructures = game.map.filter(t =>
            t.ownerId === playerId &&
            t.structure &&
            t.structure !== 'ship' &&
            !fedHexes.includes(t.id)
        );

        if (myStructures.length === 0) return [];

        // [flag: ivitsFedCumulative] 사용자 관찰(2026-07-13 e28xbh42): 이비츠 건물 21파워+정거장 6인데 연방 1개.
        // 서버 정본(computeFederationPreview)은 이비츠 요구파워(7×n 누적)를 '기존 연방 헥스를 시드에 포함한 전체'로
        // 판정 — 기존 연방(≥7)이 있으면 신규는 차액(~7)만 필요한데, 플래너가 연방 밖 건물만으로 전액(14/21)을
        // 요구해 이중 청구 → 후보 미생성이 2번째 토큰 실종의 원인. 요구치를 차액으로 보정.
        let effRequired = requiredPower;
        if (isIvits && fedHexes.length > 0 && getPlayerFlag(playerId, 'ivitsFedCumulative', true)) {
            const fedPlanetIds = new Set(game.map
                .filter(t => fedHexes.includes(t.id)
                    && ((t.ownerId === playerId && t.structure && t.structure !== 'ship') || t.parasiticMine?.ownerId === playerId))
                .map(t => t.id));
            // 4번째 인자 fedHexes: 기존 연방 내 우주정거장(파워 1)도 서버 시드와 동일하게 합산
            const existingFedPower = getFederationBuildingPower(game, playerId, fedPlanetIds, fedHexes);
            effRequired = Math.max(1, requiredPower - existingFedPower);
        }

        // Check if total power is enough
        const allMyPlanetIds = new Set(myStructures.map(t => t.id));
        if (getFederationBuildingPower(game, playerId, allMyPlanetIds) < effRequired) {
            return []; // Can't form even if we connect ALL buildings
        }

        // Greedy search from each building, then pick the best considering satellite cost.
        const round = (game as any).roundNumber ?? 1;

        const results: { selectedHexIds: string[], selectedPlanetIds: string[], rewardId: string, spentTokens: number, score: number }[] = [];

        for (const startTile of myStructures) {
            const result = this.tryFormFederationFrom(game, playerId, startTile, effRequired, availableTokens);
            if (!result) continue;

            // [flag: fedMax5Buildings] 사용자 정책(2026-06-29): 마지막 라운드(R6) 아니면 연방에 건물 5개 초과 금지.
            //   봇 연방 sprawl(많은 집을 한 연방에 몰아 위성 낭비 + 2번째 연방 재료 소진) 억제 — 좁게 모아 연방 수↑.
            //   R6은 VP만 보고 다 묶어도 무방하므로 예외(round>=6은 아래 endgame 분기로 빠짐). 게임 룰 아닌 봇 정책.
            //   (과거 '위성 수' 하드캡은 기각됐으나 이건 '건물 수' 정책 — 사용자 직접 요청.)
            // [사용자 2026-07-03] Ivits(하이브)는 건물 수 제한 자체를 없앤다 — 저파워 건물+우주정거장 다수로 연방 짜는 스타일이라
            //   5캡이 안 맞고, 1번째 연방 후 남은 광산으로 2번째 연방을 못 만들던 원인. Ivits는 fedMax5 완전 면제.
            //   그 외 종족은 캡 유지하되 '최소 연방'(7파워를 저파워건물로 겨우 채운 것)은 허용, 파워 크게 초과(sprawl)일 때만 스킵.
            if (getPlayerFlag(playerId, 'fedMax5Buildings', true) && !isIvits
                && round < 6 && result.selectedPlanetIds.length > 5) {
                const fedPow = getFederationBuildingPower(game, playerId, new Set(result.selectedPlanetIds));
                if (fedPow > requiredPower + 2) continue;
            }

            // [flag: fedEndgameVp] 마지막 라운드: 보상 선택지를 펼쳐 후보로 내보낸다 → MCTS가 각 보상의
            // '다운스트림 총 VP'(자원으로 연구5단계 보상/고급타일/라운드·최종미션 점수까지)를 시뮬해서 고름.
            // 토큰은 sunk cost라 위성 페널티 거의 0. (사용자 모델: 끝엔 12VP 강제도, 자원연방이 더 크면 그걸도.)
            if (round >= 6 && getPlayerFlag(playerId, 'fedEndgameVp', true)) {
                const availIds = this.getAvailableRewardIds(game, playerId);
                const endgameSat = result.spentTokens * 2; // 동률일 때만 위성 적은 쪽 선호
                for (const id of availIds) {
                    results.push({
                        selectedHexIds: result.selectedHexIds,
                        selectedPlanetIds: result.selectedPlanetIds,
                        rewardId: id,
                        spentTokens: result.spentTokens,
                        score: this.endgameVpScore(id) - endgameSat,
                    });
                }
                continue;
            }

            const rewardScore = this.getRewardScore(game, playerId, result.rewardId);

            // 위성(소모 파워 토큰) 절약을 유도하되,
            // hard-cut(일정 개수 초과 시 후보 자체 제거) 때문에 2번째/그 이후 연방 후보가 사라지는 문제가 있어
            // score 페널티로만 제어하도록 변경합니다.
            const isShipReward = result.rewardId.startsWith('ship-fed-') && result.rewardId !== 'ship-fed-mine-free'; // 무한 거리 광산은 쓰레기
            const greenNeeded = this.needsGreenFederation(game, playerId);

            // 기본 페널티: 위성을 쓸수록 불리하도록
            let satellitePenalty = 15;
            // 예외 상황(우주선 연방/초록 연방 급함/후반)은 위성 사용 비용을 낮춰 후보가 살아남게 함
            if (isShipReward || greenNeeded || round >= 5) satellitePenalty = 8;

            // 위성(파워 토큰) 비용. [flag: fedSatEscalate] 1~2개는 감수하되 그 이상은 급증 페널티.
            // (데이터: 봇이 흩뿌린 집을 위성 ~10개로 잇느라 파워를 다 태우고 게임이 터짐.
            //  사람은 집을 좁게 모으거나 아카/의회로 파워를 채워 위성 1~2개로 연방함.)
            const sats = result.spentTokens;
            let satCost: number;
            if (getPlayerFlag(playerId, 'fedZoneStrategy', false)) {
                // [사용자 모델] 초반 연방 위성 ≤4 선호(토큰 바닥내지 말고 후반 파워액션 여력 유지).
                // 4까지는 기본 페널티만, 5부터 급증해 '먼 집까지 위성으로 잇는 sprawl' 비선호. 하드캡 아닌 넛지(보상 크면 형성됨). R5+엔 완화.
                const escalate = round <= 4 ? 60 : 25;
                satCost = sats * satellitePenalty + Math.max(0, sats - 4) * escalate;
            } else if (getPlayerFlag(playerId, 'fedSatEscalate', true)) {
                satCost = sats * satellitePenalty + Math.max(0, sats - 2) * 35;
            } else {
                satCost = sats * satellitePenalty;
            }
            // [flag: fedPreferUpgradeSelfClose] 사용자 관찰(2026-07-06, 4+1+2 예시): 봇이 위성으로 뻗어
            //   '자체로 연방 씨앗이 될 별도 클러스터'까지 삼켜 거대 연방 1개를 만들면, 위성 낭비 + 미래 연방 소진
            //   (봇 1~2연방 vs 사람 5). 위성 브리지 연방이 자립가능 씨앗(단독 ≥요구−2 파워, 즉 그 자리 업글로
            //   self-close 가능)을 병합할 때만 페널티 → 그 클러스터는 남겨 따로 연방(+기존 R4+ 업글넛지가 닫음).
            //   ★블런트 위성캡(fedSatHumanCap −2.99) 아님: '연방 억제'가 아니라 '자립클러스터 삼킴'만 판별.
            let cannibalPenalty = 0;
            if (getPlayerFlag(playerId, 'fedPreferUpgradeSelfClose', true) && result.selectedHexIds.length > 0) {
                const seeds = this.cannibalizedSeedCount(game, playerId, result.selectedPlanetIds, requiredPower);
                cannibalPenalty = seeds * 140;
            }
            const score = rewardScore - satCost - cannibalPenalty;
            results.push({ ...result, score });
        }

        if (results.length === 0) return [];
        // 중복(같은 선택 셋) 제거 후 상위 limit개
        const seen = new Set<string>();
        const unique = results.filter(r => {
            const key = `${r.rewardId}|${[...r.selectedPlanetIds].sort().join(',')}|${[...r.selectedHexIds].sort().join(',')}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        unique.sort((a, b) => b.score - a.score);
        return unique.slice(0, Math.max(1, limit)).map(({ score: _s, ...rest }) => rest);
    }

    private static needsGreenFederation(game: ServerGameState, playerId: string): boolean {
        const player = game.players[playerId];
        if (!player) return false;

        // 1. 현재 기술 트랙 중 3단계 이상인 것이 있는지 확인.
        //    [개선] 트랙이 4에 도달한 "후"에 초록을 원하면 이미 늦어 고급타일 기회를 놓침.
        //    레벨3(곧 4)부터 미리 초록 토큰을 확보해, 4 도달 시 즉시 5로 밀고 고급타일을 가져오게 한다.
        const tracks = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
        const hasLevel3Plus = tracks.some(t => (player.research?.[t as keyof typeof player.research] ?? 0) >= 3);

        if (hasLevel3Plus) {
            // 현재 초록 연방 토큰이 없는지 확인
            const fedEntries = player.federations || [];
            const greenCount = fedEntries.filter(f => typeof f !== 'string' && f.isGreen).length;
            if (greenCount === 0) return true;
        }

        return false;
    }

    /** [flag: fedEndgameVp] 마지막 라운드 연방의 '순수 즉시 VP' 가치(×30). 엔진가치 없음 → 큰 VP 연방 우선(12>8>7).
     *  자원/토큰 보상은 쓸 시간이 없어 VP만 계산. 사용자 모델: "끝엔 12VP면 위성 무시하고라도 연방". */
    private static endgameVpScore(rewardId: string): number {
        const vp =
            (rewardId === 'fed-12vp' || rewardId === 'ship-fed-12vp') ? 12 :
            (rewardId === 'fed-8vp-1q' || rewardId === 'fed-8vp-2t' || rewardId === 'ship-fed-8vp8c') ? 8 :
            (rewardId === 'ship-fed-tech') ? 8 :   // 기술타일 후반 즉가치 근사
            (rewardId === 'fed-7vp-2o' || rewardId === 'fed-7vp-6c' || rewardId === 'ship-fed-7vp3p2t') ? 7 :
            (rewardId === 'fed-6vp-2k') ? 6 :
            (rewardId === 'ship-fed-4vp1q2o' || rewardId === 'ship-fed-4vp4k') ? 4 :
            (rewardId === 'ship-fed-3tf-mine') ? 2 :   // 광산 1개 즉가치 근사
            rewardId.startsWith('ship-fed-') ? 3 : 5;  // 미분류 보수적
        return vp * 30;
    }

    private static getRewardScore(game: ServerGameState, playerId: string, rewardId: string): number {
        let score = 0;
        // [flag: fedEndgameVp] 마지막 라운드: 순수 VP로 평가(12VP 연방을 7VP 자원연방보다 위로). 엔진/자원가치 무의미.
        if ((game.roundNumber ?? 1) >= 6 && getPlayerFlag(playerId, 'fedEndgameVp', true)) {
            return this.endgameVpScore(rewardId);
        }

        // 우선순위 1: 우주선 연방 — [개선] 기존엔 모두 300 고정이라 12VP/기술타일과 약한 보상을 동일 취급했음.
        // 사용자 지정 핵심 레버이므로 전반적으로 매력 유지하되, 가치 차등화해 좋은 우주선 연방을 선택하게 함.
        switch (rewardId) {
            case 'ship-fed-tech': return 360;      // 기술 타일 — 고급 기술타일 잠재가치 大 (최우선)
            case 'ship-fed-12vp': {
                // [사용자 관찰 2026-06-18] 초반(R≤3) 첫 연방을 12플랫VP로 먹으면 손해 — 자원 주는 연방(7VP+2O/6C=250,
                // 8VP8C=290)이 엔진을 키워 복리로 더 큼. 12VP는 엔진 다 큰 후반에 최상위. → 초반엔 자원연방 밑으로 낮춤.
                const early = (game.roundNumber ?? 1) <= 3 && getPlayerFlag(playerId, 'earlyFedResourcePref', true);
                return early ? 200 : 320;
            }
            case 'ship-fed-8vp8c': return 290;     // 8 VP + 8C
            case 'ship-fed-7vp3p2t': return 285;   // 7 VP + 2토큰 (다음 연방용)
            case 'ship-fed-4vp1q2o': return 250;   // 4 VP + 1Q + 2O
            case 'ship-fed-4vp4k': return 245;     // 4 VP + 4K
            case 'ship-fed-3tf-mine': return 240;  // 무료 광산(3테라포밍) — 확장
            case 'ship-fed-mine-free': return 90;  // Nav-ignore 무료광산 — 약함
            default: break;
        }
        if (rewardId.startsWith('ship-fed-')) return 250; // 미분류 우주선 연방 기본값

        const greenNeeded = this.needsGreenFederation(game, playerId);

        // 우선순위 2: 자원 연방 (7VP 2Ore, 7VP 6C 등)
        if (rewardId === 'fed-7vp-2o' || rewardId === 'fed-7vp-6c') {
            score = 250;
            // [flag: fedRewardResourceAware] 돈/광물 동급(250) → 돈이 남아도(또는 돈 수익이 많아도) 돈연방을 집는 문제(사용자 관찰).
            // 핵심: 현재 잔고만 보면 교역소 잔뜩 짓고 패스한 플레이어는 지금 0원이어도 다음 라운드 돈 수익이 커서 6C가 여전히 낭비.
            // → '현재 잔고 + 향후 몇 라운드치 돈 수익'을 합친 '돈 여유'로 평가. 광물은 건설 직결이라 동률 시 약간 우선.
            if (getPlayerFlag(playerId, 'fedRewardResourceAware', true)) {
                if (rewardId === 'fed-7vp-6c') {
                    const player = game.players[playerId];
                    const credits = player?.credits ?? 0;
                    const creditIncome = getNextRoundIncomePreview(playerId, game as any).credits;
                    const remaining = Math.max(1, 7 - (game.roundNumber ?? 1)); // 남은 라운드(이번 포함) 근사
                    const horizon = Math.min(3, remaining); // 최대 3라운드치만 반영(과대평가 방지)
                    const creditSupply = credits + creditIncome * horizon;
                    score -= creditSupply >= 45 ? 50 : creditSupply >= 25 ? 25 : 0;
                } else {
                    score += 2;
                }
            }
        }
        // 우선순위 3: 8VP 1QIC
        else if (rewardId === 'fed-8vp-1q') {
            score = 200;
        }
        // 우선순위 4: 6VP 2K 또는 8VP 2Tokens (5단계/고급기술 필요할 때)
        else if (rewardId === 'fed-6vp-2k' || rewardId === 'fed-8vp-2t') {
            if (greenNeeded) {
                score = 180;
            } else {
                score = 100; // 급하지 않으면 후순위
            }
        }
        // 그 외 (예: 12VP)
        else if (rewardId === 'fed-12vp') {
            // 12VP는 초록 토큰이 아니므로, 5단계 진입이 급할 때는 피해야 함
            if (greenNeeded) {
                score = 50;
            } else {
                score = 150; // 다른 자원 연방이 다 떨어졌을 때 선택
            }
        }

        return score;
    }

    /** 시작 타일에서 인접 자기 건물을 파워 높은 순으로 더해 requiredPower를 '딱 넘는' 최소 연결 부분집합 반환.
     *  component(연결 컴포넌트) 안에서만 확장해 연결성을 보장한다. 못 늘리면 null(폴백). */
    private static minimalConnectedFedSet(
        game: ServerGameState, playerId: string, startTileId: string,
        component: Set<string>, requiredPower: number
    ): Set<string> | null {
        const powerRank = (tile: HexTile): number => {
            let p = 0;
            if (tile.ownerId === playerId && tile.structure && tile.structure !== 'ship') {
                if (tile.structure === 'planetary_institute' || tile.structure === 'academy') p = 3;
                else if (tile.structure === 'trading_station' || tile.structure === 'research_lab') p = 2;
                else p = 1; // mine / lost_planet_mine
            }
            if (tile.parasiticMine?.ownerId === playerId) p += 1;
            if (tile.spaceStation?.ownerId === playerId) p += 1;
            return p;
        };
        const selected = new Set<string>([startTileId]);
        let guard = 0;
        while (getFederationBuildingPower(game, playerId, selected) < requiredPower && guard++ < 60) {
            let bestId: string | null = null, bestPow = -1;
            for (const id of Array.from(selected)) {
                const tile = game.map.find(t => t.id === id);
                if (!tile) continue;
                for (const n of getNeighbors(game.map, tile)) {
                    if (selected.has(n.id) || !component.has(n.id)) continue;
                    const p = powerRank(n);
                    if (p > bestPow) { bestPow = p; bestId = n.id; }
                }
            }
            if (!bestId) return null;
            selected.add(bestId);
        }
        return selected;
    }

    /** [fedPreferUpgradeSelfClose] 선택된 연방 건물들을 위성 없이(행성 인접만) 자연 클러스터로 분할해,
     *  1등(주 클러스터) 외에 '단독 ≥요구−2 파워'인 자립가능 씨앗 클러스터가 몇 개나 삼켜졌는지 센다. */
    private static cannibalizedSeedCount(
        game: ServerGameState, playerId: string,
        selectedPlanetIds: string[], requiredPower: number
    ): number {
        const remaining = new Set(selectedPlanetIds);
        const clusters: Set<string>[] = [];
        for (const id of selectedPlanetIds) {
            if (!remaining.has(id)) continue;
            const comp = getPlanetConnectedComponent(game, playerId, id); // 위성 아닌 행성 인접 연결성분
            const compSet = new Set<string>();
            comp.forEach((cid: string) => { if (remaining.has(cid)) { compSet.add(cid); remaining.delete(cid); } });
            remaining.delete(id);
            if (compSet.size > 0) clusters.push(compSet);
        }
        if (clusters.length <= 1) return 0;
        clusters.sort((a, b) => b.size - a.size); // 최대 = 주 클러스터(유지)
        let seeds = 0;
        for (let i = 1; i < clusters.length; i++) {
            if (getFederationBuildingPower(game, playerId, clusters[i]) >= requiredPower - 2) seeds++;
        }
        return seeds;
    }

    private static tryFormFederationFrom(
        game: ServerGameState,
        playerId: string,
        startTile: HexTile,
        requiredPower: number,
        maxTokens: number
    ): { selectedHexIds: string[], selectedPlanetIds: string[], rewardId: string, spentTokens: number } | null {
        const selectedHexIds = new Set<string>();
        const selectedPlanetIds = new Set<string>();
        const fedHexes = game.playerFederationHexes?.[playerId] || [];
        const player = game.players[playerId];
        const isIvits = player?.faction === 'ivits';

        // Always include the starting planet's connected component
        const initialComponent = getPlanetConnectedComponent(game, playerId, startTile.id);
        initialComponent.forEach(id => selectedPlanetIds.add(id));

        // [flag: ivitsFedCumulative] 서버 연결성(computeIvitsFederationConnected)은 기존 연방 칸을 통과 가능
        // 통로로 인정 — BFS도 동일하게 무비용 커넥터로 쓴다(선택/위성비용엔 미포함).
        const fedConnector = isIvits && getPlayerFlag(playerId, 'ivitsFedCumulative', true);

        let currentPower = getFederationBuildingPower(game, playerId, selectedPlanetIds);
        if (currentPower >= requiredPower) {
            // [flag: fedMinTrim] 연결 컴포넌트가 이미 7 이상이면 통째로 묶지 말고 "딱 7 넘는 최소 연결 부분집합"만
            // 연방에 넣어 초과분 건물을 다음 연방 씨앗으로 보존. 강자는 연방을 작게·여러 개 만들어 보상/초록토큰을 늘림.
            // (봇 최대 병목: 연방 1.4 vs 사람 4.5). Ivits는 누적규칙이라 제외.
            // [버그수정 2026-07-03 사용자관찰: Ivits 21파워인데 연방 1개] 기존엔 !isIvits로 Ivits를 fedMinTrim에서 제외 →
            //   연결된 큰 클러스터(14~21파워)를 통째로 1개 거대 연방으로 묶어 7VP 1회만(쪼개면 3개=21VP+보상3). Ivits도 부분집합
            //   연방은 합법이므로 제외 해제 — 최소 7파워로 쪼개 남은 건 다음 연방 씨앗으로. (flag: ivitsFedTrim로 격리 검증)
            const useTrim = getPlayerFlag(playerId, 'fedMinTrim', true) && (!isIvits || getPlayerFlag(playerId, 'ivitsFedTrim', false));
            if (useTrim && currentPower >= requiredPower + 1) {
                const trimmed = this.minimalConnectedFedSet(game, playerId, startTile.id, initialComponent, requiredPower);
                if (trimmed && getFederationBuildingPower(game, playerId, trimmed) >= requiredPower) {
                    return this.finalizeFederation(game, playerId, [], Array.from(trimmed), 0);
                }
            }
            return this.finalizeFederation(game, playerId, [], Array.from(selectedPlanetIds), 0);
        }

        // We need more power. We must add satellites (empty hexes) to connect to other components.
        // BFS to find paths to other components
        const queue: { currentHexId: string, path: string[], cost: number }[] = [];
        const visited = new Set<string>();

        // Initialize queue with neighbors of our current component
        initialComponent.forEach(pid => {
            const tile = game.map.find(t => t.id === pid)!;
            getNeighbors(game.map, tile).forEach(n => {
                // [flag: ivitsFedCumulative] 기존 연방 칸 = 무비용 통로 (선택에 안 넣음 → path 비움)
                if (fedConnector && fedHexes.includes(n.id) && !visited.has(n.id)) {
                    queue.push({ currentHexId: n.id, path: [], cost: 0 });
                    visited.add(n.id);
                    return;
                }
                // Ivits: 우주정거장 타일은 토큰 비용 없이 파워 계산에 포함될 수 있어야 함.
                if (isIvits && n.spaceStation?.ownerId === playerId && !visited.has(n.id)) {
                    queue.push({ currentHexId: n.id, path: [n.id], cost: 0 });
                    visited.add(n.id);
                    return;
                }

                if (isEmptyHex(n) && !visited.has(n.id)) {
                    // Wait, check if the empty hex is valid (not occupied by another player's satellite)
                    const onTile = game.satellites?.[n.id];
                    const playersOnTile = Array.isArray(onTile) ? onTile : (onTile ? [onTile as string] : []);
                    if (!playersOnTile.includes(playerId)) {
                        queue.push({ currentHexId: n.id, path: [n.id], cost: 1 });
                        visited.add(n.id);
                    }
                }
            });
        });

        // To simplify, we'll try to add paths one by one until we reach requiredPower.
        // A more robust algorithm would use MST or Steiner Tree, but this is a heuristic.
        let tokensSpent = 0;
        const currentPlanetIds = new Set(selectedPlanetIds);
        const currentHexIds = new Set<string>();

        // Sort queue by cost (BFS already does this implicitly if costs are 1)
        while (queue.length > 0 && currentPower < requiredPower && tokensSpent <= maxTokens) {
            const { currentHexId, path, cost } = queue.shift()!;
            if (tokensSpent + cost > maxTokens) continue;

            const currentTile = game.map.find(t => t.id === currentHexId)!;

            // Does adding this hex connect us to new planets?
            let connectedToNewComponent = false;
            const newPlanetIdsToMerge = new Set<string>();

            getNeighbors(game.map, currentTile).forEach(n => {
                if (isPlanetHex(n) && n.ownerId === playerId && n.structure && n.structure !== 'ship' && !fedHexes.includes(n.id)) {
                    const comp = getPlanetConnectedComponent(game, playerId, n.id);
                    // Check if this component is already included
                    let hasNew = false;
                    comp.forEach(cid => {
                        if (!currentPlanetIds.has(cid)) {
                            hasNew = true;
                            newPlanetIdsToMerge.add(cid);
                        }
                    });
                    if (hasNew) connectedToNewComponent = true;
                }
            });

            if (connectedToNewComponent) {
                // 이 경로의 일부가 이미 currentHexIds에 들어있을 수 있으므로 순수하게 추가된 위성 개수만 계산
                let actualNewSatellites = 0;
                path.forEach(hid => {
                    if (!currentHexIds.has(hid)) {
                        currentHexIds.add(hid);
                        const hidTile = game.map.find(t => t.id === hid);
                        // 우주정거장(공간) 타일은 Ivits 파워로 쓰되, QIC(위성/토큰) 비용에는 포함하지 않음.
                        if (isIvits && hidTile?.spaceStation?.ownerId === playerId) return;

                        // Check if the player already owns a satellite here
                        const onTile = game.satellites?.[hid];
                        const playersOnTile = Array.isArray(onTile) ? onTile : (onTile ? [onTile as string] : []);
                        if (!playersOnTile.includes(playerId)) actualNewSatellites++;
                    }
                });

                newPlanetIdsToMerge.forEach(pid => currentPlanetIds.add(pid));
                tokensSpent += actualNewSatellites;
                currentPower = getFederationBuildingPower(game, playerId, currentPlanetIds, Array.from(currentHexIds));

                if (currentPower >= requiredPower) {
                    return this.finalizeFederation(game, playerId, Array.from(currentHexIds), Array.from(currentPlanetIds), tokensSpent, requiredPower);
                }

                // Since we added new planets, add their empty neighbors to the queue
                // 새로운 컴포넌트를 병합했으므로, 큐를 초기화하여 최단 경로 탐색을 새 건물 기준(현재 연방)으로 재설정 (위성 낭비 방지)
                queue.length = 0;
                visited.clear();

                // 모든 현재 연방에 속한 행성들 및 위성들에서 다시 1거리 빈 공간 탐색
                const currentFedTiles = [
                    ...Array.from(currentPlanetIds).map(id => game.map.find(t => t.id === id)!),
                    ...Array.from(currentHexIds).map(id => game.map.find(t => t.id === id)!)
                ];

                for (const t of currentFedTiles) {
                    visited.add(t.id);
                }

                for (const t of currentFedTiles) {
                    getNeighbors(game.map, t).forEach(n => {
                        if (fedConnector && fedHexes.includes(n.id) && !visited.has(n.id)) {
                            queue.push({ currentHexId: n.id, path: [], cost: 0 });
                            visited.add(n.id);
                        } else if (isIvits && n.spaceStation?.ownerId === playerId && !visited.has(n.id)) {
                            queue.push({ currentHexId: n.id, path: [n.id], cost: 0 });
                            visited.add(n.id);
                        } else if (isEmptyHex(n) && !visited.has(n.id)) {
                            const onTile = game.satellites?.[n.id];
                            const playersOnTile = Array.isArray(onTile) ? onTile : (onTile ? [onTile as string] : []);
                            if (!playersOnTile.includes(playerId)) {
                                queue.push({ currentHexId: n.id, path: [n.id], cost: 1 });
                                visited.add(n.id);
                            }
                        }
                    });
                }
            } else {
                // Expand from this empty hex to other empty hexes
                getNeighbors(game.map, currentTile).forEach(n => {
                    if (fedConnector && fedHexes.includes(n.id) && !visited.has(n.id)) {
                        // 기존 연방 칸 통과: 지금까지의 위성 path는 유지, 연방 칸 자체는 선택 안 함
                        queue.push({ currentHexId: n.id, path: [...path], cost });
                        visited.add(n.id);
                    } else if (isIvits && n.spaceStation?.ownerId === playerId && !visited.has(n.id)) {
                        // 우주정거장 타일은 비용 없이 확장
                        queue.push({ currentHexId: n.id, path: [...path, n.id], cost: cost });
                        visited.add(n.id);
                    } else if (isEmptyHex(n) && !visited.has(n.id)) {
                        const onTile = game.satellites?.[n.id];
                        const playersOnTile = Array.isArray(onTile) ? onTile : (onTile ? [onTile as string] : []);
                        if (!playersOnTile.includes(playerId)) {
                            queue.push({ currentHexId: n.id, path: [...path, n.id], cost: cost + 1 });
                            visited.add(n.id);
                        }
                    }
                });
            }

            // Sort queue to keep it BFS (since we might have pushed longer paths)
            queue.sort((a, b) => a.cost - b.cost);
        }

        return null;
    }

    /** 지금 형성하면 받을 수 있는 연방 보상 ID 목록(일반 풀 + 내가 입장한 우주선 ship-fed 중 미취득). */
    private static getAvailableRewardIds(game: ServerGameState, playerId: string): string[] {
        const pool = game.federationPool || {};
        const player = game.players[playerId];
        const availableIds: string[] = FEDERATION_REWARDS.filter(r => pool[r.id] > 0).map(r => r.id);
        const byShip = game.spaceshipFederationByShip || {};
        const enteredTileIds = player.spaceshipsEntered ?? [];
        for (const [shipType, shipRewardId] of Object.entries(byShip)) {
            const enteredThisShip = game.map.some(t => t.type === shipType && enteredTileIds.includes(t.id));
            if (!enteredThisShip) continue;
            const taken = Object.values(game.players).some(p => getFederationEntries(p).some(e => e.rewardId === shipRewardId));
            if (!taken) availableIds.push(shipRewardId);
        }
        return availableIds;
    }

    /**
     * [flag: fedTrimSatPath] 위성 경로 연방의 과포함 트림(사용자 관찰: +1위성·8파워 과형성).
     * BFS가 연결 컴포넌트를 통째로 병합해 7파워 초과 + 잉여 위성 → 연결성·요구파워 유지하며 잉여 건물/위성 제거.
     * 안전: 결과가 연결+≥요구파워 + 실제 축소일 때만 채택, 아니면 원본(무효 연방 → game_error 방지).
     */
    private static trimFederationSet(
        game: ServerGameState, playerId: string,
        hexIds: string[], planetIds: string[], requiredPower: number
    ): { hexIds: string[], planetIds: string[] } {
        const orig = { hexIds, planetIds };
        try {
            const powerRank = (id: string): number => {
                const t = game.map.find(x => x.id === id); if (!t) return 0;
                let p = 0;
                if (t.ownerId === playerId && t.structure && t.structure !== 'ship') {
                    p = (t.structure === 'planetary_institute' || t.structure === 'academy') ? 3 : (t.structure === 'trading_station' || t.structure === 'research_lab') ? 2 : 1;
                }
                if (t.parasiticMine?.ownerId === playerId) p += 1;
                if (t.spaceStation?.ownerId === playerId) p += 1;
                return p;
            };
            const connected = (P: Set<string>, H: Set<string>): boolean => {
                const all = new Set<string>(Array.from(P).concat(Array.from(H)));
                if (all.size <= 1) return true;
                const start = all.values().next().value as string;
                const seen = new Set<string>([start]); const stack = [start];
                while (stack.length) {
                    const id = stack.pop()!; const t = game.map.find(x => x.id === id); if (!t) continue;
                    for (const n of getNeighbors(game.map, t)) {
                        if (all.has(n.id) && !seen.has(n.id)) { seen.add(n.id); stack.push(n.id); }
                    }
                }
                return seen.size === all.size;
            };
            const pow = (P: Set<string>, H: Set<string>) => getFederationBuildingPower(game, playerId, P, Array.from(H));
            const P = new Set(planetIds), H = new Set(hexIds);
            const buildings = Array.from(P).sort((a, b) => powerRank(a) - powerRank(b));
            for (const b of buildings) {
                const P2 = new Set(P); P2.delete(b);
                if (P2.size > 0 && pow(P2, H) >= requiredPower && connected(P2, H)) P.delete(b);
            }
            for (const s of Array.from(H)) {
                const H2 = new Set(H); H2.delete(s);
                if (pow(P, H2) >= requiredPower && connected(P, H2)) H.delete(s);
            }
            if (pow(P, H) >= requiredPower && connected(P, H) && (P.size + H.size) < (planetIds.length + hexIds.length)) {
                return { hexIds: Array.from(H), planetIds: Array.from(P) };
            }
        } catch { /* 폴백 */ }
        return orig;
    }

    private static finalizeFederation(
        game: ServerGameState,
        playerId: string,
        selectedHexIds: string[],
        selectedPlanetIds: string[],
        spentTokens: number,
        requiredPower?: number
    ) {
        // [flag: fedTrimSatPath] 위성 경로(hex 있음)면 과포함 트림 시도(안전 폴백 내장).
        if (requiredPower != null && selectedHexIds.length > 0
            && getPlayerFlag(playerId, 'fedTrimSatPath', true)) {
            const trimmed = this.trimFederationSet(game, playerId, selectedHexIds, selectedPlanetIds, requiredPower);
            selectedHexIds = trimmed.hexIds;
            selectedPlanetIds = trimmed.planetIds;
            spentTokens = trimmed.hexIds.length;
        }
        // [버그수정 2026-06-18] 우주선 연방(ship-fed-*)이 보상 후보에서 누락됐었음 — 일반보다 월등(12VP/기술타일 등).
        // 서버 federation_select_reward 규칙과 동일: 내가 입장한 우주선의 ship-fed가 아직 안 뺏겼으면 선택 가능(풀 무관).
        const availableIds = this.getAvailableRewardIds(game, playerId);
        if (availableIds.length === 0) return null; // No reward available

        // getRewardScore로 평가 (ship-fed를 일반보상보다 정확히 높게 — 클래스의 메인 스코어러)
        let bestReward = availableIds[0];
        let maxScore = -Infinity;
        for (const id of availableIds) {
            const score = this.getRewardScore(game, playerId, id);
            if (score > maxScore) {
                maxScore = score;
                bestReward = id;
            }
        }

        return {
            selectedHexIds,
            selectedPlanetIds,
            rewardId: bestReward,
            spentTokens
        };
    }
}
