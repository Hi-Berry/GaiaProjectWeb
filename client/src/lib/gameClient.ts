import { io, Socket } from 'socket.io-client';
import type { GaiaGameState as GameState, PlayerState, StructureType, ResearchTrack } from '@shared/gameConfig';

export type { GameState, PlayerState, StructureType, ResearchTrack };

export type ChatMessage = NonNullable<GameState['chatMessages']>[number];

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
    });
  }
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export function getStoredPlayerId(gameId: string): string | null {
  return localStorage.getItem(`gaia-${gameId}-playerId`);
}

export function storePlayerId(gameId: string, playerId: string) {
  localStorage.setItem(`gaia-${gameId}-playerId`, playerId);
}

export function getStoredSpectatorId(gameId: string): string | null {
  return localStorage.getItem(`gaia-${gameId}-spectatorId`);
}

export function storeSpectatorId(gameId: string, spectatorId: string) {
  localStorage.setItem(`gaia-${gameId}-spectatorId`, spectatorId);
}

// [낙관적 UI 동기화] 프리액션을 빠르게 연타하면, 서버가 이전 프리액션을 처리하며 보낸 옛 game_updated가
// 뒤늦게 도착해 더 최신인 클라 낙관상태를 덮어써 되돌아가는(rubber-banding) 현상이 있다. 클라가 '이번 턴
// 낙관적으로 보낸 프리액션 수'(_optimisticFreeCount)를 세고, 서버의 freeActionUndoStack.length와 비교해
// 서버가 뒤처진 패킷은 Game.tsx에서 무시한다(곧 따라잡은 패킷이 온다). undo는 감소, 권위패킷 적용 시 동기화.
let _optimisticFreeCount = 0;
let _lastFreeActionAt = 0;
// [러버밴딩 v2] '이미 화면에 적용한 서버 프리액션 수'의 최고치. 연타로 optimisticCount가 서버를 추월(거부 클릭 포함)해도
// UI가 동결되지 않도록, 스킵 기준을 'optimisticCount 미달'이 아니라 '이미 적용한 수보다 후퇴(stale)'로 바꾸기 위함.
let _lastAppliedServerFreeCount = 0;

export const GameClient = {
  listGames(): Promise<{
    games: Array<{
      id: string;
      playerCount: number;
      maxPlayers: number;
      phase: string;
      createdAt: number;
      hostName: string | null;
      players: Array<{ id: string; name: string; isHost: boolean }>;
    }>;
  }> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('list_games', (response: any) => {
        if (response.error) reject(new Error(response.error));
        else resolve(response);
      });
    });
  },

  createGame(playerName: string, password?: string): Promise<{ gameId: string; playerId: string; game: GameState }> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('create_game', { playerName, password: password || undefined }, (response: any) => {
        if (response.error) reject(new Error(response.error));
        else resolve(response);
      });
    });
  },

  joinGame(gameId: string, playerName: string, password?: string): Promise<{ gameId: string; playerId: string; game: GameState }> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('join_game', { gameId, playerName, password: password || undefined }, (response: any) => {
        if (response.error) reject(new Error(response.error));
        else resolve(response);
      });
    });
  },

  /** 방 한정 이름/비번으로 좌석 복귀(다른 기기 이어하기) — 참가 시 비번을 걸었던 좌석의 playerId를 받는다 */
  accountRejoin(gameId: string, playerName: string, password: string): Promise<{ gameId: string; playerId: string; playerName: string }> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('account_rejoin', { gameId, playerName, password }, (response: any) => {
        if (response.error) reject(new Error(response.error));
        else resolve(response);
      });
    });
  },

  watchGame(gameId: string): Promise<{ gameId: string; spectatorId: string; game: GameState }> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('watch_game', { gameId }, (response: any) => {
        if (response.error) reject(new Error(response.error));
        else resolve(response);
      });
    });
  },

  getGame(gameId: string): Promise<{ game: GameState }> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('get_game', { gameId }, (response: any) => {
        if (response.error) reject(new Error(response.error));
        else resolve(response);
      });
    });
  },

  // 진행 중 게임의 분석용 로그 스냅샷 받기 (최종 저장과 동일 포맷)
  exportGameSnapshot(gameId: string): Promise<{ payload: any }> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('export_game_snapshot', { gameId }, (response: any) => {
        if (response.error) reject(new Error(response.error));
        else resolve(response);
      });
    });
  },

  rejoinGame(gameId: string, playerId: string): Promise<{ game: GameState }> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('rejoin_game', { gameId, playerId }, (response: any) => {
        if (response.error) reject(new Error(response.error));
        else resolve(response);
      });
    });
  },

  leaveGame(gameId: string) {
    const s = getSocket();
    s.emit('leave_game', { gameId });
    localStorage.removeItem(`gaia-${gameId}-playerId`);
  },

  /** 방장 전용: 플레이어 슬롯 추가 (한 컴퓨터 4인플용). 반환: { playerId, name, game } */
  hostAddPlayer(gameId: string, playerName?: string): Promise<{ playerId: string; name: string; game: GameState }> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('host_add_player', { gameId, playerName }, (response: any) => {
        if (response.error) reject(new Error(response.error));
        else resolve(response);
      });
    });
  },

  /** 방장 전용: 시작 전 로비에서 방 삭제. 성공 시 모두 로비로 나가게 됨 */
  deleteGame(gameId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('delete_game', { gameId }, (response: any) => {
        if (response?.error) reject(new Error(response.error));
        else resolve();
      });
    });
  },

  hostAddBot(gameId: string, botName?: string): Promise<{ botId: string; name: string; game: GameState }> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('host_add_bot', { gameId, botName }, (response: any) => {
        if (response.error) reject(new Error(response.error));
        else resolve(response);
      });
    });
  },

  /** 현재 조작할 플레이어로 전환 (방장은 아무 플레이어나 선택 가능, 한 컴퓨터 교대 플레이용) */
  switchPlayer(gameId: string, playerId: string): Promise<{ game: GameState }> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('rejoin_game', { gameId, playerId }, (response: any) => {
        if (response.error) reject(new Error(response.error));
        else resolve({ game: response.game });
      });
    });
  },

  /** 방장 전용: 로비에서 추가한 플레이어/봇 제거 */
  removePlayer(gameId: string, targetPlayerId: string): Promise<{ game: GameState }> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('host_remove_player', { gameId, targetPlayerId }, (response: any) => {
        if (response?.error) reject(new Error(response.error));
        else resolve({ game: response.game });
      });
    });
  },

  startGame(gameId: string) {
    const s = getSocket();
    s.emit('start_game', { gameId });
  },

  setUseFactionBidding(gameId: string, useFactionBidding: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('set_use_faction_bidding', { gameId, useFactionBidding }, (response: any) => {
        if (response?.error) reject(new Error(response.error));
        else resolve();
      });
    });
  },

  factionBidRaise(gameId: string, newBid: number) {
    const s = getSocket();
    s.emit('faction_bid_raise', { gameId, newBid });
  },

  factionBidPass(gameId: string) {
    const s = getSocket();
    s.emit('faction_bid_pass', { gameId });
  },

  factionBidPick(gameId: string, factionId: string, turnOrder: number) {
    const s = getSocket();
    s.emit('faction_bid_pick', { gameId, factionId, turnOrder });
  },

  autoSetupTest(gameId: string) {
    const s = getSocket();
    s.emit('auto_setup_test', { gameId });
  },

  selectFaction(gameId: string, factionId: string, turnOrder?: number) {
    const s = getSocket();
    s.emit('select_faction', { gameId, factionId, turnOrder });
  },

  confirmFactions(gameId: string) {
    const s = getSocket();
    s.emit('confirm_factions', { gameId });
  },

  placeStartingMine(gameId: string, tileId: string, factionId?: string) {
    const s = getSocket();
    s.emit('place_starting_mine', { gameId, tileId, factionId });
  },

  buildMine(gameId: string, tileId: string, useGaiaformer?: boolean) {
    const s = getSocket();
    s.emit('build_mine', { gameId, tileId, useGaiaformer });
  },

  placeGaiaformer(gameId: string, tileId: string, qicUsed?: number) {
    const s = getSocket();
    s.emit('place_gaiaformer', { gameId, tileId, qicUsed: qicUsed || 0 });
  },

  placeIvitsSpaceStation(gameId: string, tileId: string) {
    const s = getSocket();
    s.emit('place_ivits_space_station', { gameId, tileId });
  },

  placeLostPlanet(gameId: string, tileId: string, qicToSpend: number) {
    const s = getSocket();
    s.emit('place_lost_planet', { gameId, tileId, qicToSpend });
  },

  endTurn(gameId: string) {
    const s = getSocket();
    s.emit('end_turn', { gameId });
  },

  resetTurn(gameId: string) {
    const s = getSocket();
    s.emit('reset_turn', { gameId });
  },

  selectIncomeItem(gameId: string, itemId: string) {
    const s = getSocket();
    s.emit('select_income_item', { gameId, itemId });
  },

  selectAllIncomeItems(gameId: string) {
    const s = getSocket();
    s.emit('select_all_income_items', { gameId });
  },

  undoIncomeItem(gameId: string) {
    const s = getSocket();
    s.emit('undo_income_item', { gameId });
  },

  finishIncomeSelection(gameId: string) {
    const s = getSocket();
    s.emit('finish_income_selection', { gameId });
  },

  respondPowerOffer(gameId: string, offerId: string, accept: boolean, brainFirst?: boolean, piAddFirst?: boolean) {
    const s = getSocket();
    const payload: { gameId: string; offerId: string; accept: boolean; brainFirst?: boolean; piAddFirst?: boolean } = { gameId, offerId, accept };
    if (brainFirst !== undefined) payload.brainFirst = brainFirst;
    if (piAddFirst !== undefined) payload.piAddFirst = piAddFirst;
    s.emit('respond_power_offer', payload);
  },

  acceptAllPowerOffers(gameId: string) {
    const s = getSocket();
    s.emit('accept_all_power_offers', { gameId });
  },

  toggleTestMode(gameId: string) {
    const s = getSocket();
    s.emit('toggle_test_mode', { gameId });
  },

  debugSetResources(gameId: string, resources: Partial<PlayerState>) {
    const s = getSocket();
    s.emit('debug_set_resources', { gameId, resources });
  },

  adminSetPlayerState(gameId: string, targetPlayerId: string, resources: Partial<PlayerState>, adminCode: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('admin_set_player_state', { gameId, targetPlayerId, resources, adminCode }, (response: any) => {
        if (response?.error) reject(new Error(response.error));
        else resolve();
      });
    });
  },

  adminForceEndGame(gameId: string, adminCode: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('admin_force_end_game', { gameId, adminCode }, (response: any) => {
        if (response?.error) reject(new Error(response.error));
        else resolve();
      });
    });
  },

  /** 타클론: 파워 소비 시 브레인 스톤 우선 사용 전역 토글 */
  setTaklonsBrainPriority(gameId: string, value: boolean) {
    const s = getSocket();
    s.emit('set_taklons_brain_priority', { gameId, value });
  },

  /** GM/Admin: 현재 턴을 특정 플레이어로 강제 지정 (디버그용, 서버 가드 있음) */
  adminSetCurrentTurn(gameId: string, targetPlayerId: string, adminCode: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('admin_set_current_turn', { gameId, targetPlayerId, adminCode }, (response: any) => {
        if (response?.error) reject(new Error(response.error));
        else resolve();
      });
    });
  },

  adminRollbackTurn(gameId: string, adminCode: string, targetPlayerId?: string): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('admin_rollback_turn', { gameId, adminCode, targetPlayerId }, (response: any) => {
        if (response?.error) reject(new Error(response.error));
        else resolve(response?.playerName);
      });
    });
  },

  /** GM/Admin: 연방 토큰의 초록/빨강 상태 토글 (이미 뒤집힌 연방을 다시 초록으로 되돌리기 등) */
  adminToggleFederationGreen(gameId: string, targetPlayerId: string, federationIndex: number, adminCode: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('admin_toggle_federation_green', { gameId, targetPlayerId, federationIndex, adminCode }, (response: any) => {
        if (response?.error) reject(new Error(response.error));
        else resolve(!!response?.isGreen);
      });
    });
  },

  upgradeStructure(gameId: string, tileId: string, target: StructureType | 'academy_left' | 'academy_right') {
    const s = getSocket();
    s.emit('upgrade_structure', { gameId, tileId, target });
  },

  advanceTech(gameId: string, trackId: ResearchTrack) {
    const s = getSocket();
    s.emit('advance_tech', { gameId, trackId });
  },

  usePowerAction(gameId: string, actionId: string) {
    const s = getSocket();
    s.emit('use_power_action', { gameId, actionId });
  },

  useBalTakGaiaformerToQic(gameId: string) {
    const s = getSocket();
    s.emit('use_bal_tak_gaiaformer_to_qic', { gameId });
  },

  useHadschHallasPIAction(gameId: string, actionId: string) {
    const s = getSocket();
    _optimisticFreeCount++; _lastFreeActionAt = Date.now();
    s.emit('use_hadsch_hallas_pi_action', { gameId, actionId });
  },

  passRound(gameId: string, newBonusTileId?: string) {
    const s = getSocket();
    s.emit('pass_round', { gameId, newBonusTileId });
  },

  selectBonusTile(gameId: string, bonusTileId: string) {
    const s = getSocket();
    s.emit('select_bonus_tile', { gameId, bonusTileId });
  },

  useBonusAction(gameId: string) {
    const s = getSocket();
    s.emit('use_bonus_action', { gameId });
  },

  burnPower(gameId: string, moveBrainToBowl3?: boolean) {
    const s = getSocket();
    const payload: { gameId: string; moveBrainToBowl3?: boolean } = { gameId };
    if (moveBrainToBowl3 !== undefined) payload.moveBrainToBowl3 = moveBrainToBowl3;
    _optimisticFreeCount++; _lastFreeActionAt = Date.now();
    s.emit('burn_power', payload);
  },

  convertResource(gameId: string, type: string, useBrain?: boolean) {
    const s = getSocket();
    const payload: { gameId: string; type: string; useBrain?: boolean } = { gameId, type };
    if (useBrain !== undefined) payload.useBrain = useBrain;
    _optimisticFreeCount++; _lastFreeActionAt = Date.now();
    s.emit('convert_resource', payload);
  },

  gainTechTile(gameId: string, tileId: string) {
    const s = getSocket();
    s.emit('gain_tech_tile', { gameId, tileId });
  },

  useTechAction(gameId: string, tileId: string) {
    const s = getSocket();
    s.emit('use_tech_action', { gameId, tileId });
  },

  selectTechTile(gameId: string, techTileId: string, trackId?: string, advanceToLevel5?: boolean) {
    const s = getSocket();
    const payload: { gameId: string; techTileId: string; trackId?: string; advanceToLevel5?: boolean } = { gameId, techTileId };
    if (trackId != null && trackId !== '') payload.trackId = trackId;
    if (advanceToLevel5 != null) payload.advanceToLevel5 = advanceToLevel5;
    s.emit('select_tech_tile', payload);
  },

  /** 고급 기술 타일 선택 (덮을 타일 선택 대기로 전환). trackId 없으면 7번째(추가) 고급 타일 */
  selectAdvancedTechTile(gameId: string, advancedTileId: string, trackId?: ResearchTrack) {
    const payload: { gameId: string; advancedTileId: string; trackId?: ResearchTrack } = { gameId, advancedTileId };
    if (trackId != null) payload.trackId = trackId;
    getSocket().emit('select_advanced_tech_tile', payload);
  },

  /** 고급 기술 타일로 덮을 일반 타일 확정 */
  confirmAdvancedTechCover(gameId: string, coverTileId: string) {
    getSocket().emit('confirm_advanced_tech_cover', { gameId, coverTileId });
  },

  undoFreeAction(gameId: string, steps?: number) {
    const s = getSocket();
    const payload: { gameId: string; steps?: number } = { gameId };
    if (steps != null && Number.isFinite(steps) && steps > 0) payload.steps = Math.floor(steps);
    const dec = Math.max(1, Math.floor(steps ?? 1));
    _optimisticFreeCount = Math.max(0, _optimisticFreeCount - dec);
    // undo는 정당한 후퇴 → 적용 기준선도 낮춰 줘야 서버의 낮아진 카운트 패킷이 스킵되지 않음.
    _lastAppliedServerFreeCount = Math.max(0, _lastAppliedServerFreeCount - dec);
    _lastFreeActionAt = Date.now();
    s.emit('undo_free_action', payload);
  },

  // 낙관적 프리액션 동기화 헬퍼 (rubber-banding 방지) — Game.tsx의 game_updated 핸들러가 사용.
  getOptimisticFreeCount(): number { return _optimisticFreeCount; },
  lastOptimisticFreeActionAt(): number { return _lastFreeActionAt; },
  syncOptimisticFreeCount(serverCount: number): void { _optimisticFreeCount = Math.max(0, serverCount | 0); },
  // [러버밴딩 v2] 단조 진행 기준선. 적용한 최고 서버 카운트보다 낮은(stale) 패킷만 스킵.
  getLastAppliedServerFreeCount(): number { return _lastAppliedServerFreeCount; },
  noteAppliedServerFreeCount(n: number): void { _lastAppliedServerFreeCount = (n | 0) <= 0 ? 0 : Math.max(_lastAppliedServerFreeCount, n | 0); },
  resetAppliedServerFreeCount(): void { _lastAppliedServerFreeCount = 0; },

  useSpecialAction(gameId: string, actionId: string) {
    const s = getSocket();
    s.emit('use_special_action', { gameId, actionId });
  },

  /** 팅커로이드: 라운드 시작 시 고른 Special 액션 확정 */
  tinkeroidChooseSpecial(gameId: string, actionId: string) {
    const s = getSocket();
    s.emit('tinkeroid_choose_special', { gameId, actionId });
  },

  /** 엠바스(Ambas) Special: 의회와 광산 위치 교체 (mineTileId = 교체할 광산 타일) */
  ambasSwapPiMine(gameId: string, mineTileId: string) {
    const s = getSocket();
    s.emit('ambas_swap_pi_mine', { gameId, mineTileId });
  },

  /** 매안(Bescods) Special: 가장 낮은 트랙 중 하나 +1 (trackId = 올릴 트랙) */
  bescodsAdvanceLowestTrack(gameId: string, trackId: string) {
    const s = getSocket();
    s.emit('bescods_advance_lowest_track', { gameId, trackId });
  },

  /** 파이락(Firaks) Special: 연구소→교역소 다운그레이드 + 트랙 1칸 (tileId = 연구소 타일, trackId = 올릴 트랙) */
  firaksDowngrade(gameId: string, tileId: string, trackId: string) {
    const s = getSocket();
    s.emit('firaks_downgrade', { gameId, tileId, trackId });
  },

  moweyipPlaceRing(gameId: string, tileId: string) {
    const s = getSocket();
    s.emit('moweyip_place_ring', { gameId, tileId });
  },

  enterSpaceship(gameId: string, tileId: string, useRangeBonus?: boolean, qicToUse?: number) {
    const s = getSocket();
    s.emit('enter_spaceship', { gameId, tileId, useRangeBonus: useRangeBonus ?? false, qicToUse: qicToUse ?? 0 });
  },

  useShipAction(gameId: string, shipTileId: string, actionIndex: number, targetTileId?: string) {
    const s = getSocket();
    s.emit('use_ship_action', { gameId, shipTileId, actionIndex, targetTileId });
  },

  confirmTwilightFederation(gameId: string, rewardId: string) {
    const s = getSocket();
    s.emit('confirm_twilight_federation', { gameId, rewardId });
  },

  cancelTwilightFederation(gameId: string) {
    const s = getSocket();
    s.emit('cancel_twilight_federation', { gameId });
  },

  takeTwilightArtifact(gameId: string, artifactId: string) {
    const s = getSocket();
    s.emit('take_twilight_artifact', { gameId, artifactId });
  },

  skipTFMarsGaiaProject(gameId: string) {
    const s = getSocket();
    s.emit('skip_tfmars_gaia_project', { gameId });
  },

  cancelEclipseResearch(gameId: string) {
    const s = getSocket();
    s.emit('cancel_eclipse_research', { gameId });
  },

  cancelEclipseAsteroidMine(gameId: string) {
    const s = getSocket();
    s.emit('cancel_eclipse_asteroid_mine', { gameId });
  },

  eclipseAdvanceTrack(gameId: string, trackId: ResearchTrack) {
    const s = getSocket();
    s.emit('eclipse_advance_track', { gameId, trackId });
  },

  eclipseBuildAsteroidMine(gameId: string, tileId: string, qicToSpend = 0) {
    const s = getSocket();
    s.emit('eclipse_build_asteroid_mine', { gameId, tileId, qicToSpend });
  },

  federationToggleMode(gameId: string) {
    const s = getSocket();
    s.emit('federation_toggle_mode', { gameId });
  },

  federationToggleHex(gameId: string, tileId: string) {
    const s = getSocket();
    s.emit('federation_toggle_hex', { gameId, tileId });
  },

  federationComplete(gameId: string, force = false) {
    const s = getSocket();
    s.emit('federation_complete', { gameId, force });
  },

  /** 연방 선언 시 불필요한 위성이 있을 때 서버가 보내는 경고 (force=true로 재요청하면 그대로 진행) */
  onFederationRedundantWarning(callback: (data: { count: number }) => void) {
    const s = getSocket();
    s.on('federation_redundant_warning', callback);
    return () => s.off('federation_redundant_warning', callback);
  },

  federationSelectReward(gameId: string, rewardId: string) {
    const s = getSocket();
    s.emit('federation_select_reward', { gameId, rewardId });
  },

  submitAiFeedback(gameId: string, feedback: { actionId?: string; rating: string; expertMove?: string; reason?: string; tags?: string[] }): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('submit_ai_feedback', { gameId, ...feedback }, (response: any) => {
        if (response?.error) reject(new Error(response.error));
        else resolve();
      });
    });
  },

  /** Terran council: exchange tokens (4→QIC/K, 3→O, 1→C). Total cost must be ≤ tokenCount. */
  terranCouncilConfirmBenefits(gameId: string, qic: number, knowledge: number, ore: number, credits: number) {
    const s = getSocket();
    s.emit('terran_council_confirm_benefits', { gameId, qic, knowledge, ore, credits });
  },

  /** Itars PI: 4 tokens → 1 Tech Tile, or stop and return remaining to Bowl 1 */
  itarsGaiaformerExchangeChoice(gameId: string, takeTile: boolean) {
    const s = getSocket();
    s.emit('itars_gaiaformer_exchange_choice', { gameId, takeTile });
  },

  onGameUpdated(callback: (game: GameState) => void) {
    const s = getSocket();
    s.on('game_updated', callback);
    return () => s.off('game_updated', callback);
  },

  onGameError(callback: (err: { message: string }) => void) {
    const s = getSocket();
    s.on('game_error', callback);
    return () => s.off('game_error', callback);
  },

  onError(callback: (error: { message: string }) => void) {
    const s = getSocket();
    s.on('error', callback);
    return () => s.off('error', callback);
  },

  sendChat(gameId: string, text: string) {
    const s = getSocket();
    s.emit('send_chat', { gameId, text });
  },

  onChatMessage(callback: (msg: ChatMessage) => void) {
    const s = getSocket();
    s.on('chat_message', callback);
    return () => s.off('chat_message', callback);
  },

  onGameDeleted(callback: (payload: { gameId: string }) => void) {
    const s = getSocket();
    s.on('game_deleted', callback);
    return () => s.off('game_deleted', callback);
  },
};
