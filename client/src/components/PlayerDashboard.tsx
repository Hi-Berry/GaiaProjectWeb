import { usePlayer } from "@/hooks/use-game";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { motion } from "framer-motion";
import { PowerActions } from "./PowerActions";
import { ResearchTracks } from "./ResearchTracks";

function ScoreTrack({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-0.5 px-2 py-1 bg-gradient-to-r from-slate-800 to-slate-900 rounded">
      {Array.from({ length: 16 }).map((_, i) => (
        <div 
          key={i}
          className={`w-5 h-5 flex items-center justify-center text-[10px] font-mono border
            ${i === score ? 'bg-yellow-500 border-yellow-400 text-black font-bold' : 'bg-slate-700/50 border-slate-600/50 text-slate-400'}`}
          data-testid={`score-track-${i}`}
        >
          {i}
        </div>
      ))}
    </div>
  );
}

function PowerCycle({ power1, power2, power3 }: { power1: number; power2: number; power3: number }) {
  return (
    <div className="bg-gradient-to-br from-purple-900/40 to-slate-900/60 rounded-lg p-3 border border-purple-500/20">
      <div className="text-[10px] font-bold uppercase text-purple-300 mb-2 text-center">Power Cycle</div>
      <div className="flex items-center justify-center gap-2">
        {/* Bowl I */}
        <div className="flex flex-col items-center" data-testid="power-bowl-1">
          <div className="w-14 h-14 rounded-full bg-purple-900/40 border-2 border-purple-500/50 flex flex-col items-center justify-center">
            <span className="text-[10px] text-purple-300 font-bold">I</span>
            <span className="text-lg font-bold text-white" data-testid="power-bowl-1-value">{power1}</span>
          </div>
        </div>
        
        {/* Arrow I to II */}
        <div className="text-purple-400 text-lg">→</div>
        
        {/* Bowl II */}
        <div className="flex flex-col items-center" data-testid="power-bowl-2">
          <div className="w-14 h-14 rounded-full bg-purple-900/50 border-2 border-purple-500/60 flex flex-col items-center justify-center">
            <span className="text-[10px] text-purple-300 font-bold">II</span>
            <span className="text-lg font-bold text-white" data-testid="power-bowl-2-value">{power2}</span>
          </div>
        </div>
        
        {/* Arrow II to III */}
        <div className="text-purple-400 text-lg">→</div>
        
        {/* Bowl III */}
        <div className="flex flex-col items-center" data-testid="power-bowl-3">
          <div className="w-16 h-16 rounded-full bg-purple-800/60 border-2 border-purple-400 shadow-[0_0_12px_rgba(168,85,247,0.4)] flex flex-col items-center justify-center">
            <span className="text-[10px] text-purple-300 font-bold">III</span>
            <span className="text-xl font-bold text-white" data-testid="power-bowl-3-value">{power3}</span>
          </div>
        </div>
      </div>
      
      {/* Spend indicator */}
      <div className="flex justify-center mt-2">
        <div className="text-[9px] text-purple-400/70 flex items-center gap-1">
          <span>III</span>
          <span className="text-purple-500">→ spend →</span>
          <span>I</span>
        </div>
      </div>
    </div>
  );
}

function StructureArea({ 
  title, 
  slots, 
  available, 
  cost,
  color 
}: { 
  title: string; 
  slots: number; 
  available: number;
  cost: string;
  color: string;
}) {
  return (
    <div className="bg-slate-800/50 rounded border border-slate-600/30 p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-bold uppercase text-slate-400">{title}</span>
        <span className="text-[8px] text-slate-500">{cost}</span>
      </div>
      <div className="flex gap-1">
        {Array.from({ length: slots }).map((_, i) => (
          <div 
            key={i}
            className={`w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold
              ${i < available ? `${color} text-white` : 'bg-slate-700/30 border border-dashed border-slate-500/30'}`}
            data-testid={`structure-${title.toLowerCase().replace(' ', '-')}-${i}`}
          >
            {i < available ? title[0] : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

function TerraformingLadder() {
  const planets = [
    { type: 'terra', color: 'bg-blue-500', label: 'Terra', steps: 0 },
    { type: 'oxide', color: 'bg-red-500', label: 'Oxide', steps: 1 },
    { type: 'volcanic', color: 'bg-orange-500', label: 'Volcanic', steps: 2 },
    { type: 'desert', color: 'bg-yellow-500', label: 'Desert', steps: 3 },
    { type: 'swamp', color: 'bg-amber-700', label: 'Swamp', steps: 4 },
    { type: 'titanium', color: 'bg-gray-400', label: 'Titanium', steps: 3 },
    { type: 'ice', color: 'bg-cyan-200', label: 'Ice', steps: 2 },
    { type: 'transdim', color: 'bg-purple-500', label: 'Transdim', steps: 1 },
  ];

  return (
    <div className="bg-slate-800/50 rounded border border-slate-600/30 p-2">
      <div className="text-[10px] font-bold uppercase text-slate-400 mb-2 text-center">Terraforming</div>
      <div className="flex flex-col gap-1">
        {planets.map((planet) => (
          <div key={planet.type} className="flex items-center gap-2">
            <div className={`w-4 h-4 rounded-full ${planet.color}`} />
            <span className="text-[9px] text-slate-300 flex-1">{planet.label}</span>
            <span className="text-[9px] text-amber-400 font-mono">{planet.steps > 0 ? `${planet.steps * 3} ore` : '-'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResourceDisplay({ label, value, max, color, icon }: { label: string; value: number; max: number; color: string; icon: string }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="text-[10px] font-bold text-slate-400 w-12">{icon}</span>
      <div className="flex-1 flex gap-0.5">
        {Array.from({ length: Math.min(max, 15) }).map((_, i) => (
          <div 
            key={i}
            className={`h-4 flex-1 rounded-sm ${i < value ? color : 'bg-slate-700/30'}`}
          />
        ))}
        {max > 15 && <span className="text-[9px] text-slate-500">+{max - 15}</span>}
      </div>
      <span className="text-sm font-mono font-bold w-6 text-right text-white" data-testid={`resource-${label.toLowerCase()}-value`}>{value}</span>
    </div>
  );
}

export function PlayerDashboard({ playerId }: { playerId: number }) {
  const { data: player, isLoading } = usePlayer(playerId);

  if (isLoading) {
    return (
      <div className="h-full w-full p-4 space-y-4">
        <Skeleton className="h-8 w-3/4 mb-4" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (!player) return null;

  return (
    <Card className="h-full bg-gradient-to-b from-slate-900 to-slate-950 border-white/10 flex flex-col overflow-y-auto">
      {/* Faction Header */}
      <div className="p-3 bg-gradient-to-r from-blue-900/40 to-slate-900 border-b border-slate-700/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-500 border-2 border-blue-400 flex items-center justify-center">
              <span className="text-lg font-bold text-white">T</span>
            </div>
            <div>
              <h2 className="text-lg font-display font-bold text-white" data-testid="text-faction">
                {player.faction}
              </h2>
              <span className="text-[10px] text-blue-400">Planet: Terra</span>
            </div>
          </div>
        </div>
      </div>

      {/* Score Track */}
      <div className="p-2 border-b border-slate-700/30">
        <ScoreTrack score={player.score} />
      </div>

      {/* Power Cycle */}
      <div className="p-3 border-b border-slate-700/30">
        <PowerCycle power1={player.power1} power2={player.power2} power3={player.power3} />
      </div>

      {/* Structure Areas - Grid layout matching the image */}
      <div className="p-3 border-b border-slate-700/30">
        <div className="grid grid-cols-2 gap-2">
          <StructureArea title="Planetary Inst." slots={1} available={1} cost="4o 6c" color="bg-cyan-700" />
          <StructureArea title="Academy" slots={2} available={2} cost="6o 6c" color="bg-indigo-700" />
          <StructureArea title="Trading Stn." slots={4} available={4} cost="2o 6c" color="bg-yellow-700" />
          <StructureArea title="Research Lab" slots={3} available={3} cost="3o 5c" color="bg-blue-700" />
        </div>
        <div className="mt-2">
          <StructureArea title="Mine" slots={8} available={8} cost="1o 2c" color="bg-amber-800" />
        </div>
      </div>

      {/* Resources */}
      <div className="p-3 border-b border-slate-700/30">
        <div className="text-[10px] font-bold uppercase text-slate-400 mb-2">Resources</div>
        <ResourceDisplay label="Ore" value={player.ore} max={15} color="bg-amber-600" icon="Ore" />
        <ResourceDisplay label="Knowledge" value={player.knowledge} max={15} color="bg-blue-500" icon="Know" />
        <ResourceDisplay label="Credits" value={player.credits} max={30} color="bg-yellow-500" icon="Credits" />
        <ResourceDisplay label="QIC" value={player.qic} max={7} color="bg-emerald-500" icon="Q.I.C" />
      </div>

      {/* Terraforming Ladder */}
      <div className="p-3 border-b border-slate-700/30">
        <TerraformingLadder />
      </div>

      {/* Power Actions */}
      <div className="p-3 border-b border-slate-700/30">
        <PowerActions 
          playerId={playerId} 
          power2={player.power2} 
          power3={player.power3} 
        />
      </div>

      {/* Research Tracks */}
      <div className="p-3 flex-1">
        <ResearchTracks player={player} />
      </div>

      {/* Faction Ability */}
      <div className="p-3 bg-slate-800/50 border-t border-slate-700/30">
        <div className="text-[10px] font-bold uppercase text-cyan-400 mb-1">Faction Ability</div>
        <p className="text-[9px] text-slate-400 leading-relaxed">
          During the Gaia phase, move the power tokens in your Gaia area to area II of your power cycle instead of to area I.
        </p>
      </div>
    </Card>
  );
}
