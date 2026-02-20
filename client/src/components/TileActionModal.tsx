import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { usePlayerAction, usePlayer, useMap } from "@/hooks/use-game";
import { useToast } from "@/hooks/use-toast";
import { Building, Pickaxe, Rocket, ArrowUp, Store, FlaskConical, GraduationCap, Landmark, Navigation } from "lucide-react";
import type { Tile } from "@shared/schema";

const PLANET_NAMES: Record<string, string> = {
  terra: 'Terra',
  oxide: 'Oxide',
  volcanic: 'Volcanic',
  desert: 'Desert',
  swamp: 'Swamp',
  titanium: 'Titanium',
  ice: 'Ice',
  transdim: 'Transdim',
  gaia: 'Gaia',
  space: 'Empty Space',
  deep_space: 'Deep Space',
};

const STRUCTURE_NAMES: Record<string, string> = {
  mine: 'Mine',
  trading_station: 'Trading Station',
  research_lab: 'Research Lab',
  planetary_institute: 'Planetary Institute',
  academy: 'Academy',
  ship: 'Ship',
};

const UPGRADE_COSTS: Record<string, { ore: number, credits: number }> = {
  trading_station: { ore: 2, credits: 6 },
  planetary_institute: { ore: 4, credits: 6 },
  research_lab: { ore: 3, credits: 5 },
  academy: { ore: 6, credits: 6 },
};

interface TileActionModalProps {
  tile: Tile | null;
  playerId: number;
  open: boolean;
  onClose: () => void;
}

interface UpgradeOptionProps {
  targetStructure: string;
  icon: React.ElementType;
  player: any;
  action: any;
  playerId: number;
  tileId: number;
  toast: any;
  onClose: () => void;
}

function UpgradeOption({ targetStructure, icon: Icon, player, action, playerId, tileId, toast, onClose }: UpgradeOptionProps) {
  const cost = UPGRADE_COSTS[targetStructure];
  const canAfford = player && player.ore >= cost.ore && player.credits >= cost.credits;
  
  const handleUpgrade = async () => {
    try {
      await action.mutateAsync({
        id: playerId,
        type: 'upgrade_structure',
        params: { tileId, targetStructure }
      });
      toast({
        title: "Structure Upgraded",
        description: `Upgraded to ${STRUCTURE_NAMES[targetStructure]}`,
      });
      onClose();
    } catch (e: any) {
      toast({
        title: "Error",
        description: e.message,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="p-3 rounded-lg bg-secondary/30 border border-white/5">
      <div className="flex items-center justify-between mb-2">
        <span className="font-semibold flex items-center gap-2">
          <ArrowUp className="w-4 h-4 text-green-400" />
          <Icon className="w-4 h-4" />
          Upgrade to {STRUCTURE_NAMES[targetStructure]}
        </span>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Cost: {cost.ore} Ore + {cost.credits} Credits
      </p>
      <Button
        onClick={handleUpgrade}
        disabled={!canAfford || action.isPending}
        className="w-full"
        data-testid={`button-upgrade-${targetStructure.replace('_', '-')}`}
      >
        {action.isPending ? 'Upgrading...' : `Upgrade to ${STRUCTURE_NAMES[targetStructure]}`}
      </Button>
      {!canAfford && (
        <p className="text-xs text-destructive mt-2">Not enough resources</p>
      )}
    </div>
  );
}

// Calculate terraforming steps for the color wheel
const PLANET_WHEEL = ['terra', 'oxide', 'volcanic', 'desert', 'swamp', 'titanium', 'ice', 'transdim'];
const HOME_PLANET = 'terra'; // Terrans home planet

function calculateTerraformCost(tileType: string, terraformingLevel: number) {
  if (tileType === 'gaia' || tileType === HOME_PLANET || tileType === 'space' || tileType === 'deep_space') {
    return { steps: 0, oreCost: 1, needsQIC: tileType === 'gaia' };
  }
  
  const homeIndex = PLANET_WHEEL.indexOf(HOME_PLANET);
  const targetIndex = PLANET_WHEEL.indexOf(tileType);
  if (targetIndex < 0) return { steps: 0, oreCost: 1, needsQIC: false };
  
  const clockwise = (targetIndex - homeIndex + 8) % 8;
  const counterClockwise = (homeIndex - targetIndex + 8) % 8;
  const steps = Math.min(clockwise, counterClockwise);
  
  const baseCostPerStep = 3;
  const costPerStep = Math.max(1, baseCostPerStep - terraformingLevel);
  const terraformOreCost = steps * costPerStep;
  
  return { steps, oreCost: 1 + terraformOreCost, needsQIC: false };
}

// Calculate hex distance between two tiles
function hexDistance(t1: { q: number, r: number }, t2: { q: number, r: number }) {
  const dx = t1.q - t2.q;
  const dy = t1.r - t2.r;
  return Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dx + dy));
}

// Check if a tile is in range from owned tiles
function checkRange(tile: { q: number, r: number }, ownedTiles: { q: number, r: number }[], maxRange: number) {
  if (ownedTiles.length === 0) return { inRange: true, distance: 0 }; // No structures = starting placement
  
  let minDistance = Infinity;
  for (const owned of ownedTiles) {
    const dist = hexDistance(tile, owned);
    if (dist < minDistance) minDistance = dist;
  }
  
  return { inRange: minDistance <= maxRange, distance: minDistance };
}

export function TileActionModal({ tile, playerId, open, onClose }: TileActionModalProps) {
  const action = usePlayerAction();
  const { data: player } = usePlayer(playerId);
  const { data: allTiles } = useMap();
  const { toast } = useToast();

  if (!tile) return null;

  const canBuildMine = tile.type !== 'space' && tile.type !== 'deep_space' && !tile.structure;
  const canDeployShip = (tile.type === 'space' || tile.type === 'deep_space') && !tile.structure;
  
  // Starting phase: can place 2 mines on Terra planets for free
  const startingMinesPlaced = player?.startingMinesPlaced || 0;
  const inStartingPhase = startingMinesPlaced < 2;
  const canPlaceStartingMine = inStartingPhase && tile.type === 'terra' && !tile.structure;
  
  // Calculate terraforming cost
  const terraformingLevel = player?.researchTerraforming || 0;
  const terraformInfo = calculateTerraformCost(tile.type, terraformingLevel);
  const hasResources = player && player.ore >= terraformInfo.oreCost && player.credits >= 2;
  const hasQIC = player && player.qic >= 1;
  
  // Calculate range from owned tiles
  const navigationLevel = player?.researchNavigation || 0;
  const maxRange = 1 + navigationLevel;
  const ownedTiles = allTiles?.filter(t => t.ownerId === playerId && t.structure) || [];
  const rangeInfo = checkRange(tile, ownedTiles, maxRange);
  
  const canAffordMine = hasResources && (!terraformInfo.needsQIC || hasQIC) && rangeInfo.inRange;

  const handleBuildMine = async () => {
    try {
      await action.mutateAsync({
        id: playerId,
        type: 'build_mine',
        params: { tileId: tile.id }
      });
      toast({
        title: "Mine Built",
        description: `Built a mine on ${PLANET_NAMES[tile.type] || tile.type}`,
      });
      onClose();
    } catch (e: any) {
      toast({
        title: "Error",
        description: e.message,
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="bg-card border-white/10 max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="text-lg" data-testid="text-planet-type">{PLANET_NAMES[tile.type] || tile.type}</span>
            <span className="text-xs text-muted-foreground font-mono" data-testid="text-tile-coords">({tile.q}, {tile.r})</span>
          </DialogTitle>
          <DialogDescription data-testid="text-tile-description">
            {tile.structure 
              ? `Structure: ${tile.structure}` 
              : 'This planet is uninhabited.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-4">
          {/* Starting Phase Banner */}
          {inStartingPhase && (
            <div className="p-3 rounded-lg bg-blue-900/30 border border-blue-500/30">
              <p className="text-sm font-semibold text-blue-300">Starting Phase</p>
              <p className="text-xs text-blue-400/80">
                Place {2 - startingMinesPlaced} more mine(s) on Terra planets for free
              </p>
            </div>
          )}
          
          {/* Starting Mine Placement (Free on Terra) */}
          {canPlaceStartingMine && (
            <div className="p-3 rounded-lg bg-green-900/30 border border-green-500/30">
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold flex items-center gap-2 text-green-300">
                  <Pickaxe className="w-4 h-4" />
                  Place Starting Mine (FREE)
                </span>
              </div>
              <p className="text-xs text-green-400/80 mb-3">
                Free placement on your home planet type (Terra)
              </p>
              <Button
                onClick={async () => {
                  try {
                    await action.mutateAsync({
                      id: playerId,
                      type: 'place_starting_mine',
                      params: { tileId: tile.id }
                    });
                    toast({
                      title: "Starting Mine Placed",
                      description: `Placed starting mine ${startingMinesPlaced + 1}/2`,
                    });
                    onClose();
                  } catch (e: any) {
                    toast({
                      title: "Error",
                      description: e.message,
                      variant: "destructive",
                    });
                  }
                }}
                disabled={action.isPending}
                className="w-full"
                variant="default"
                data-testid="button-place-starting-mine"
              >
                {action.isPending ? 'Placing...' : 'Place Starting Mine'}
              </Button>
            </div>
          )}
          
          {canBuildMine && !tile.structure && !canPlaceStartingMine && (
            <div className="p-3 rounded-lg bg-secondary/30 border border-white/5">
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold flex items-center gap-2">
                  <Pickaxe className="w-4 h-4" />
                  Build Mine
                </span>
              </div>
              <div className="text-xs text-muted-foreground mb-3 space-y-1">
                <div className="flex items-center gap-2 mb-2" data-testid="text-range-info">
                  <Navigation className="w-3 h-3" />
                  <span>
                    Distance: {rangeInfo.distance === Infinity ? 'N/A' : rangeInfo.distance} | 
                    Max Range: {maxRange} (Nav Lv.{navigationLevel})
                  </span>
                  {rangeInfo.inRange ? (
                    <span className="text-green-400">In Range</span>
                  ) : (
                    <span className="text-red-400">Out of Range</span>
                  )}
                </div>
                <p>Base Cost: 1 Ore + 2 Credits</p>
                {terraformInfo.steps > 0 && (
                  <p className="text-amber-400" data-testid="text-terraform-cost">
                    + Terraforming: {terraformInfo.oreCost - 1} Ore ({terraformInfo.steps} step{terraformInfo.steps > 1 ? 's' : ''})
                  </p>
                )}
                {terraformInfo.needsQIC && (
                  <p className="text-purple-400" data-testid="text-gaia-cost">
                    + Gaia Conversion: 1 Q.I.C
                  </p>
                )}
                <p className="font-semibold text-foreground" data-testid="text-total-cost">
                  Total: {terraformInfo.oreCost} Ore + 2 Credits{terraformInfo.needsQIC ? ' + 1 Q.I.C' : ''}
                </p>
              </div>
              <Button
                onClick={handleBuildMine}
                disabled={!canAffordMine || action.isPending}
                className="w-full"
                data-testid="button-build-mine"
              >
                {action.isPending ? 'Building...' : 'Build Mine'}
              </Button>
              {!rangeInfo.inRange && (
                <p className="text-xs text-destructive mt-2">Planet is out of range</p>
              )}
              {rangeInfo.inRange && !hasResources && (
                <p className="text-xs text-destructive mt-2">Not enough resources</p>
              )}
            </div>
          )}
          
          {/* Normal Build Mine (during starting phase, show for non-Terra planets) */}
          {canBuildMine && !tile.structure && inStartingPhase && tile.type !== 'terra' && (
            <div className="p-3 rounded-lg bg-secondary/30 border border-white/5 opacity-60">
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold flex items-center gap-2 text-muted-foreground">
                  <Pickaxe className="w-4 h-4" />
                  Build Mine (After Starting Phase)
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Place your 2 starting mines on Terra planets first
              </p>
            </div>
          )}

          {tile.structure && (
            <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
              <div className="flex items-center gap-2">
                <Building className="w-5 h-5 text-primary" />
                <span className="font-semibold" data-testid="text-structure-name">{STRUCTURE_NAMES[tile.structure] || tile.structure}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {tile.ownerId === playerId ? 'Your structure' : `Owned by Player ${tile.ownerId}`}
              </p>
            </div>
          )}

          {tile.structure === 'mine' && tile.ownerId === playerId && (
            <UpgradeOption
              targetStructure="trading_station"
              icon={Store}
              player={player}
              action={action}
              playerId={playerId}
              tileId={tile.id}
              toast={toast}
              onClose={onClose}
            />
          )}

          {tile.structure === 'trading_station' && tile.ownerId === playerId && (
            <>
              <UpgradeOption
                targetStructure="research_lab"
                icon={FlaskConical}
                player={player}
                action={action}
                playerId={playerId}
                tileId={tile.id}
                toast={toast}
                onClose={onClose}
              />
              <UpgradeOption
                targetStructure="planetary_institute"
                icon={Landmark}
                player={player}
                action={action}
                playerId={playerId}
                tileId={tile.id}
                toast={toast}
                onClose={onClose}
              />
            </>
          )}

          {tile.structure === 'research_lab' && tile.ownerId === playerId && (
            <UpgradeOption
              targetStructure="academy"
              icon={GraduationCap}
              player={player}
              action={action}
              playerId={playerId}
              tileId={tile.id}
              toast={toast}
              onClose={onClose}
            />
          )}

          {canDeployShip && (
            <div className="p-3 rounded-lg bg-secondary/30 border border-white/5">
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold flex items-center gap-2">
                  <Rocket className="w-4 h-4" />
                  Deploy Ship
                </span>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Cost: 1 Q.I.C (Forgotten Fleet)
              </p>
              <Button
                onClick={async () => {
                  try {
                    await action.mutateAsync({
                      id: playerId,
                      type: 'deploy_ship',
                      params: { tileId: tile.id }
                    });
                    toast({
                      title: "Ship Deployed",
                      description: `Deployed a ship to ${tile.type === 'deep_space' ? 'deep space' : 'space'}`,
                    });
                    onClose();
                  } catch (e: any) {
                    toast({
                      title: "Error",
                      description: e.message,
                      variant: "destructive",
                    });
                  }
                }}
                disabled={!hasQIC || action.isPending}
                className="w-full"
                data-testid="button-deploy-ship"
              >
                {action.isPending ? 'Deploying...' : 'Deploy Ship'}
              </Button>
              {!hasQIC && (
                <p className="text-xs text-destructive mt-2">Not enough Q.I.C</p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
