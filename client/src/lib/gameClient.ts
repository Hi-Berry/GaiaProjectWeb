import { io, Socket } from 'socket.io-client';
import type { GaiaGameState as GameState, PlayerState, StructureType, ResearchTrack } from '@shared/gameConfig';

export type { GameState, PlayerState, StructureType, ResearchTrack };

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

export const GameClient = {
  listGames(): Promise<{ games: Array<{ id: string; playerCount: number; maxPlayers: number; phase: string; createdAt: number }> }> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('list_games', (response: any) => {
        if (response.error) reject(new Error(response.error));
        else resolve(response);
      });
    });
  },

  createGame(playerName: string): Promise<{ gameId: string; playerId: string; game: GameState }> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('create_game', { playerName }, (response: any) => {
        if (response.error) reject(new Error(response.error));
        else resolve(response);
      });
    });
  },

  joinGame(gameId: string, playerName: string): Promise<{ gameId: string; playerId: string; game: GameState }> {
    return new Promise((resolve, reject) => {
      const s = getSocket();
      s.emit('join_game', { gameId, playerName }, (response: any) => {
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

  startGame(gameId: string) {
    const s = getSocket();
    s.emit('start_game', { gameId });
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
    s.emit('burn_power', payload);
  },

  convertResource(gameId: string, type: string, useBrain?: boolean) {
    const s = getSocket();
    const payload: { gameId: string; type: string; useBrain?: boolean } = { gameId, type };
    if (useBrain !== undefined) payload.useBrain = useBrain;
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

  selectTechTile(gameId: string, techTileId: string, trackId?: string) {
    const s = getSocket();
    const payload: { gameId: string; techTileId: string; trackId?: string } = { gameId, techTileId };
    if (trackId != null && trackId !== '') payload.trackId = trackId;
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

  takeTwilightArtifact(gameId: string, artifactId: string) {
    const s = getSocket();
    s.emit('take_twilight_artifact', { gameId, artifactId });
  },

  skipTFMarsGaiaProject(gameId: string) {
    const s = getSocket();
    s.emit('skip_tfmars_gaia_project', { gameId });
  },

  eclipseAdvanceTrack(gameId: string, trackId: ResearchTrack) {
    const s = getSocket();
    s.emit('eclipse_advance_track', { gameId, trackId });
  },

  eclipseBuildAsteroidMine(gameId: string, tileId: string) {
    const s = getSocket();
    s.emit('eclipse_build_asteroid_mine', { gameId, tileId });
  },

  federationToggleMode(gameId: string) {
    const s = getSocket();
    s.emit('federation_toggle_mode', { gameId });
  },

  federationToggleHex(gameId: string, tileId: string) {
    const s = getSocket();
    s.emit('federation_toggle_hex', { gameId, tileId });
  },

  federationComplete(gameId: string) {
    const s = getSocket();
    s.emit('federation_complete', { gameId });
  },

  federationSelectReward(gameId: string, rewardId: string) {
    const s = getSocket();
    s.emit('federation_select_reward', { gameId, rewardId });
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
};
