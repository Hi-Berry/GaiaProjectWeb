import { Button } from "@/components/ui/button";
import { usePlayerAction } from "@/hooks/use-game";
import { useToast } from "@/hooks/use-toast";
import { Coins, Database, Circle, Box, ArrowDown } from "lucide-react";

interface PowerActionsProps {
  playerId: number;
  power2: number;
  power3: number;
}

export function PowerActions({ playerId, power2, power3 }: PowerActionsProps) {
  const action = usePlayerAction();
  const { toast } = useToast();

  const handleConvert = async (resource: string, ratio: number) => {
    try {
      await action.mutateAsync({
        id: playerId,
        type: 'convert_power',
        params: { resource, amount: 1 }
      });
      toast({
        title: "Power Converted",
        description: `Converted ${ratio} power to 1 ${resource}`,
      });
    } catch (e: any) {
      toast({
        title: "Error",
        description: e.message,
        variant: "destructive",
      });
    }
  };

  const handleSacrifice = async () => {
    try {
      await action.mutateAsync({
        id: playerId,
        type: 'sacrifice_power',
        params: { amount: 1 }
      });
      toast({
        title: "Power Sacrificed",
        description: "Sacrificed 2 from Bowl 2 to gain 1 in Bowl 3",
      });
    } catch (e: any) {
      toast({
        title: "Error",
        description: e.message,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">
        Free Actions
      </h4>
      
      <Button
        size="sm"
        variant="outline"
        className="w-full justify-between text-xs font-mono"
        onClick={handleSacrifice}
        disabled={power2 < 2 || action.isPending}
        data-testid="button-sacrifice-power"
      >
        <span className="flex items-center gap-2">
          <ArrowDown className="w-3 h-3" />
          Bowl2 -2 → Bowl3 +1
        </span>
        <span className="text-muted-foreground">({power2})</span>
      </Button>

      <div className="grid grid-cols-2 gap-2">
        <Button
          size="sm"
          variant="outline"
          className="text-xs font-mono gap-1"
          onClick={() => handleConvert('credits', 1)}
          disabled={power3 < 1 || action.isPending}
          data-testid="button-convert-credits"
        >
          <Coins className="w-3 h-3 text-yellow-400" />
          1:1 Credit
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="text-xs font-mono gap-1"
          onClick={() => handleConvert('ore', 3)}
          disabled={power3 < 3 || action.isPending}
          data-testid="button-convert-ore"
        >
          <Database className="w-3 h-3 text-amber-500" />
          3:1 Ore
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="text-xs font-mono gap-1"
          onClick={() => handleConvert('knowledge', 4)}
          disabled={power3 < 4 || action.isPending}
          data-testid="button-convert-knowledge"
        >
          <Circle className="w-3 h-3 text-blue-400" />
          4:1 Knowledge
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="text-xs font-mono gap-1"
          onClick={() => handleConvert('qic', 4)}
          disabled={power3 < 4 || action.isPending}
          data-testid="button-convert-qic"
        >
          <Box className="w-3 h-3 text-emerald-400" />
          4:1 Q.I.C
        </Button>
      </div>
    </div>
  );
}
