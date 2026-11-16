/**
 * [사용자 2026-11-16] "아이타가 의회 능력으로 타일 3개 가져오는 사이에 란티다가 액션을 해버렸다. 2삽 타일 가져오면서 발생한 일"
 *   "광산 건설까지 완료해야 아이타 의회 행동 종료야"
 *
 * 아이타 의회 교환(4토큰 → 기술 타일)의 '후속 처리' 구간을 알려 준다 — 교환 대기·타일 고르기(councilPendingActive)는
 * 이미 막혀 있었지만, 우주선 기술 2TF+무료광산을 고르면 그 두 표시가 꺼지고 '광산 지은 뒤 체인 재개'
 * (itarsExchangeResumeAfterShipMine)만 남는다. 그 사이(무료 광산 → 트랙 전진 → 남은 교환) 다른 사람의 행동이 열려 있었다.
 * 트랙 전진·고급 타일 덮기 같은 다른 후속 처리도 같은 성격이라 함께 본다.
 *
 * 반환: 후속 처리를 하고 있는 아이타 플레이어 id(그 사람만 행동 가능), 없으면 null.
 */
type AnyGame = {
	players?: Record<string, { faction?: string | null } | undefined>;
	itarsExchangeResumeAfterShipMine?: boolean;
	pendingShipTechMine?: { playerId: string } | null;
	pendingShipTechTrackAdvance?: { playerId: string; fromItars?: boolean } | null;
	pendingAdvancedTechCover?: { playerId: string; fromItarsExchange?: boolean } | null;
	pendingAdvancedTechTrackAdvance?: { playerId: string; fromItarsExchange?: boolean } | null;
};

export function itarsCouncilFollowUpOwner(game: unknown): string | null {
	const g = (game ?? {}) as AnyGame;
	if (g.itarsExchangeResumeAfterShipMine) {
		return g.pendingShipTechMine?.playerId
			?? g.pendingShipTechTrackAdvance?.playerId
			?? Object.keys(g.players ?? {}).find((id) => g.players?.[id]?.faction === 'itars')
			?? null;
	}
	if (g.pendingShipTechTrackAdvance?.fromItars) return g.pendingShipTechTrackAdvance.playerId;
	if (g.pendingAdvancedTechCover?.fromItarsExchange) return g.pendingAdvancedTechCover.playerId;
	if (g.pendingAdvancedTechTrackAdvance?.fromItarsExchange) return g.pendingAdvancedTechTrackAdvance.playerId;
	return null;
}

/**
 * 아이타 후속 처리 중 '주인이 아닌 사람'에게 막을 이벤트 — 메인 액션·무료 행동·턴 종료·패스·턴 리셋.
 * 파워 받기 응답·수입·채팅·롤백 투표·관리자 기능은 막지 않는다(아이타 무료 광산이 주는 파워는 받아야 한다).
 */
export const ITARS_FOLLOWUP_GATED_EVENTS: ReadonlySet<string> = new Set([
	'use_bonus_action', 'build_mine', 'enter_spaceship', 'use_ship_action', 'take_twilight_artifact',
	'skip_tfmars_gaia_project', 'cancel_eclipse_research', 'cancel_eclipse_asteroid_mine', 'eclipse_advance_track',
	'eclipse_build_asteroid_mine', 'confirm_twilight_federation', 'cancel_twilight_federation', 'place_gaiaformer',
	'place_ivits_space_station', 'place_lost_planet', 'upgrade_structure', 'select_tech_tile', 'skip_tech_tile_selection',
	'reset_turn', 'advance_tech', 'use_power_action', 'use_hadsch_hallas_pi_action', 'use_bal_tak_gaiaformer_to_qic',
	'convert_resource', 'burn_power', 'undo_free_action', 'select_advanced_tech_tile', 'confirm_advanced_tech_cover',
	'gain_tech_tile', 'use_tech_action', 'use_special_action', 'ambas_swap_pi_mine', 'bescods_advance_lowest_track',
	'moweyip_place_ring', 'skip_ship_tech_mine', 'skip_spaceship_fed_mine', 'firaks_downgrade', 'federation_complete',
	'federation_select_reward', 'end_turn', 'pass_round', 'select_bonus_tile',
]);

/** 이 이벤트를 이 사람이 지금 보내면 막아야 하는지 — 막으면 안내 문구, 아니면 null. (서버 소켓 입구에서 사용) */
export function itarsFollowUpBlockMessage(
	game: unknown,
	event: string,
	playerId: string | null | undefined,
): string | null {
	if (!game || !playerId || !ITARS_FOLLOWUP_GATED_EVENTS.has(event)) return null;
	const owner = itarsCouncilFollowUpOwner(game);
	if (!owner || owner === playerId) return null;
	const name = (game as { players?: Record<string, { name?: string } | undefined> }).players?.[owner]?.name;
	return `${name ?? '아이타'}님의 아이타 의회 능력 처리(광산·트랙까지)를 기다리는 중입니다. 끝나면 이어집니다.`;
}
