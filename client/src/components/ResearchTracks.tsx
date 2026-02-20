import { Player } from "@shared/schema";
import { motion } from "framer-motion";
import { Mountain, Compass, Cpu, Globe, TrendingUp, Lightbulb } from "lucide-react";

interface ResearchTrackProps {
  name: string;
  icon: React.ElementType;
  level: number;
  color: string;
  testId: string;
}

const RESEARCH_AREAS = [
  { key: 'researchTerraforming', name: 'Terraforming', icon: Mountain, color: 'from-orange-500 to-red-600' },
  { key: 'researchNavigation', name: 'Navigation', icon: Compass, color: 'from-blue-500 to-cyan-600' },
  { key: 'researchAI', name: 'AI', icon: Cpu, color: 'from-purple-500 to-pink-600' },
  { key: 'researchGaia', name: 'Gaia Project', icon: Globe, color: 'from-green-500 to-emerald-600' },
  { key: 'researchEconomy', name: 'Economy', icon: TrendingUp, color: 'from-yellow-500 to-amber-600' },
  { key: 'researchScience', name: 'Science', icon: Lightbulb, color: 'from-indigo-500 to-violet-600' },
] as const;

function ResearchTrack({ name, icon: Icon, level, color, testId }: ResearchTrackProps) {
  return (
    <div className="flex items-center gap-3" data-testid={testId}>
      <div className={`p-1.5 rounded-lg bg-gradient-to-br ${color} text-white shadow-lg`}>
        <Icon size={14} />
      </div>
      <div className="flex-1">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-muted-foreground">{name}</span>
          <span className="text-xs font-mono font-bold text-white" data-testid={`${testId}-level`}>{level}</span>
        </div>
        <div className="flex gap-1">
          {[0, 1, 2, 3, 4, 5].map((lvl) => (
            <motion.div
              key={lvl}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                lvl <= level 
                  ? `bg-gradient-to-r ${color}` 
                  : 'bg-secondary/50'
              }`}
              initial={false}
              animate={{ opacity: lvl <= level ? 1 : 0.4 }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function ResearchTracks({ player }: { player: Player }) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Research Tracks</h3>
      {RESEARCH_AREAS.map((area) => (
        <ResearchTrack
          key={area.key}
          name={area.name}
          icon={area.icon}
          level={player[area.key] as number}
          color={area.color}
          testId={`research-${area.key.replace('research', '').toLowerCase()}`}
        />
      ))}
    </div>
  );
}
